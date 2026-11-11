// Small Neon API client: only the calls the scripts need.
import { readFileSync } from "node:fs";

const API = "https://console.neon.tech/api/v2";

// Reads .env next to package.json, without a dependency.
export function loadEnv() {
  try {
    for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    // no .env: use the environment as it is
  }
}

export function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (see .env.example)`);
  return v;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ApiError extends Error {
  constructor(method, path, status, body) {
    super(`${method} ${path} -> ${status} ${String(body).slice(0, 400)}`);
    this.status = status;
    this.body = body;
  }
}

export async function api(method, path, body) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(API + path, {
      method,
      headers: { Authorization: `Bearer ${need("NEON_API_KEY")}`, "Content-Type": "application/json", Accept: "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(120_000),
    }).catch((e) => ({ ok: false, status: 0, text: async () => e.message }));
    if (res.ok) return res.status === 204 ? {} : res.json();
    const text = await res.text();
    // 423: another operation is running on the project. 429 and 5xx: try again.
    if ((res.status === 0 || res.status === 423 || res.status === 429 || res.status >= 500) && attempt < 10) {
      await sleep(1000 * attempt);
      continue;
    }
    throw new ApiError(method, path, res.status, text);
  }
}

export async function waitOperations(projectId, operations = []) {
  for (const op of operations) {
    for (let i = 0; ; i++) {
      const { operation } = await api("GET", `/projects/${projectId}/operations/${op.id}`);
      // "skipped": the API decided the step was not needed (for example a
      // config change on an idle compute). It is done, not pending.
      if (operation.status === "finished" || operation.status === "skipped") break;
      if (["failed", "error", "cancelled"].includes(operation.status)) throw new Error(`operation ${operation.action} ${op.id} ${operation.status}`);
      if (i > 1200) throw new Error(`operation ${op.id} still ${operation.status} after 10 minutes`);
      await sleep(500);
    }
  }
}

// pooled=false must be explicit: without it the API returns the pooled string.
export async function connectionUri(projectId, { branchId, pooled = false, database = "neondb", role = "neondb_owner", computeId } = {}) {
  const q = new URLSearchParams({ database_name: database, role_name: role, pooled: String(pooled) });
  if (branchId) q.set("branch_id", branchId);
  if (computeId) q.set("endpoint_id", computeId);
  return (await api("GET", `/projects/${projectId}/connection_uri?${q}`)).uri;
}

export async function createProject({ name, region = "aws-us-east-2", pgVersion = 18, orgId }) {
  const project = { name, region_id: region, pg_version: pgVersion };
  if (orgId) project.org_id = orgId;
  // A small fixed compute on the default endpoint keeps cost predictable.
  const r = await api("POST", "/projects", {
    project: {
      ...project,
      default_endpoint_settings: { autoscaling_limit_min_cu: 0.25, autoscaling_limit_max_cu: 0.25, suspend_timeout_seconds: 60 },
    },
  });
  await waitOperations(r.project.id, r.operations);
  return r;
}

export async function getProject(projectId) {
  return (await api("GET", `/projects/${projectId}`)).project;
}

export async function listBranches(projectId) {
  return (await api("GET", `/projects/${projectId}/branches`)).branches;
}

export async function getDefaultBranch(projectId) {
  const branches = await listBranches(projectId);
  return branches.find((b) => b.default) ?? branches[0];
}

export async function branchEndpoints(projectId, branchId) {
  return (await api("GET", `/projects/${projectId}/branches/${branchId}/endpoints`)).endpoints;
}

// A child branch with its own compute. parentTimestamp makes it a
// point-in-time branch of the parent at that instant.
export async function createBranch(projectId, { name, parentId, parentTimestamp, cu = 0.25, maxCu = cu, suspend = 60 } = {}) {
  const branch = { name };
  if (parentId) branch.parent_id = parentId;
  if (parentTimestamp) branch.parent_timestamp = parentTimestamp;
  const r = await api("POST", `/projects/${projectId}/branches`, {
    branch,
    endpoints: [{ type: "read_write", autoscaling_limit_min_cu: cu, autoscaling_limit_max_cu: maxCu, suspend_timeout_seconds: suspend }],
  });
  await waitOperations(projectId, r.operations);
  return r;
}

// A read replica (read_only endpoint) on an existing branch.
export async function createReadReplica(projectId, branchId, { cu = 0.25, maxCu = 1, suspend = 60 } = {}) {
  const r = await api("POST", `/projects/${projectId}/endpoints`, {
    endpoint: { branch_id: branchId, type: "read_only", autoscaling_limit_min_cu: cu, autoscaling_limit_max_cu: maxCu, suspend_timeout_seconds: suspend },
  });
  await waitOperations(projectId, r.operations);
  return r.endpoint;
}

export async function updateEndpoint(projectId, endpointId, { minCu, maxCu, suspend } = {}) {
  const endpoint = {};
  if (minCu !== undefined) endpoint.autoscaling_limit_min_cu = minCu;
  if (maxCu !== undefined) endpoint.autoscaling_limit_max_cu = maxCu;
  if (suspend !== undefined) endpoint.suspend_timeout_seconds = suspend;
  const r = await api("PATCH", `/projects/${projectId}/endpoints/${endpointId}`, { endpoint });
  await waitOperations(projectId, r.operations);
  return r.endpoint;
}

export async function restartEndpoint(projectId, endpointId) {
  const r = await api("POST", `/projects/${projectId}/endpoints/${endpointId}/restart`);
  await waitOperations(projectId, r.operations);
  return r;
}

export async function deleteProject(projectId) {
  return api("DELETE", `/projects/${projectId}`);
}

export async function deleteBranch(projectId, branchId) {
  const r = await api("DELETE", `/projects/${projectId}/branches/${branchId}`);
  await waitOperations(projectId, r.operations);
}

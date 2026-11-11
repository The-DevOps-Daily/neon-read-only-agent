// Stage 1: create the throwaway Neon project and record its settings.
import { loadEnv, createProject, getDefaultBranch, branchEndpoints } from "../lib/neon.mjs";
import { writeState } from "../lib/record.mjs";

loadEnv();

const name = `read-only-agent-${new Date().toISOString().slice(0, 10)}`;
const region = process.env.NEON_REGION || "aws-us-east-2";
const pgVersion = Number(process.env.PG_VERSION || 18);
const orgId = process.env.NEON_ORG_ID || undefined;

console.log(`creating project ${name} in ${region}, PG ${pgVersion}...`);
const { project, connection_uris } = await createProject({ name, region, pgVersion, orgId });
const branch = await getDefaultBranch(project.id);
const endpoints = await branchEndpoints(project.id, branch.id);
const primary = endpoints.find((e) => e.type === "read_write");

const state = {
  projectId: project.id,
  projectName: project.name,
  region,
  pgVersion: project.pg_version,
  branchId: branch.id,
  primaryEndpointId: primary?.id,
  ownerRole: connection_uris?.[0]?.connection_parameters?.role || "neondb_owner",
  database: connection_uris?.[0]?.connection_parameters?.database || "neondb",
  createdAt: new Date().toISOString(),
};
writeState(state);
console.log(JSON.stringify({ ...state }, null, 2));
console.log("\nproject created. next: npm run seed");

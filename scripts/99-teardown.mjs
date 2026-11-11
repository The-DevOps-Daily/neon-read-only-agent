// Deletes the throwaway project. Run this when the measurements are done.
import { loadEnv, deleteProject } from "../lib/neon.mjs";
import { readState } from "../lib/record.mjs";

loadEnv();
const state = readState();
if (!state.projectId) throw new Error("no projectId in .state.json");
console.log(`deleting project ${state.projectId} (${state.projectName})...`);
await deleteProject(state.projectId);
console.log("deleted. the project, its branches, roles and all data are gone.");

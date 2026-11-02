import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TreeLabels } from "./src/marks/labels.ts";
import { registerMarksReader } from "./src/marks/reader.ts";
import { createMarkTool, loadGuidance } from "./src/marks/tool.ts";
import { registerRecallCommand } from "./src/command/command.ts";
import { recallTool } from "./src/recall.ts";
import { searchTool } from "./src/search.ts";
import { sessionsTool } from "./src/sessions-tool.ts";

export default function (pi: ExtensionAPI) {
  pi.registerTool(recallTool);
  pi.registerTool(sessionsTool);
  pi.registerTool(searchTool);
  const labels = new TreeLabels((entryId, label) => pi.setLabel(entryId, label));
  labels.register(pi);
  pi.registerTool(createMarkTool(loadGuidance(), labels));
  registerMarksReader(pi);
  registerRecallCommand(pi, labels);
}

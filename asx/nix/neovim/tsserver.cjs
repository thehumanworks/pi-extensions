// The loader resolves these imports from the installed asx package. TypeScript
// cannot discover a Nix store installation through a project's node_modules.
const { join, normalize } = require("node:path");
const { homedir } = require("node:os");
const { asxPackage } = require("./package.json");

const agentWorkflows = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "workflows") + "/";
const workflowFile = file => normalize(file).includes("/.pi/workflows/") || normalize(file).startsWith(agentWorkflows);
const aliases = ["@nothumanwork/asx", "typebox", "@earendil-works/pi-durable", "@earendil-works/pi-ai"];

module.exports = ({ typescript: ts }) => {
  const from = join(asxPackage, "index.ts");
  const options = { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler };
  const nodeTypes = ts.resolveTypeReferenceDirective("node", from, options, ts.sys).resolvedTypeReferenceDirective;

  return {
    create(info) {
      const host = info.languageServiceHost;
      const original = host.resolveModuleNameLiterals.bind(host);
      host.resolveModuleNameLiterals = (literals, containingFile, ...rest) => {
        const resolved = original(literals, containingFile, ...rest);
        if (!workflowFile(containingFile)) return resolved;
        return resolved.map((entry, index) => {
          const name = literals[index].text;
          // Match the runtime's installed aliases even if a project has a stale
          // local asx version; preserve every unrelated import and paths entry.
          if (!aliases.some(alias => name === alias || name.startsWith(alias + "/"))) return entry;
          return ts.resolveModuleName(name, from, options, ts.sys);
        });
      };
      return info.languageService;
    },
    getExternalFiles(project) {
      // Standalone workflows run in Node. A tsconfig's explicit types and other
      // compiler settings remain authoritative for configured projects.
      if (!nodeTypes || project.projectKind !== ts.server.ProjectKind.Inferred) return [];
      const file = project.getRootFiles().find(workflowFile);
      if (!file || ts.resolveTypeReferenceDirective("node", file, project.getCompilationSettings(), ts.sys).resolvedTypeReferenceDirective) return [];
      return [nodeTypes.resolvedFileName];
    },
  };
};

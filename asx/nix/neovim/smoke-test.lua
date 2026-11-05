-- Run against the installed editor plugin, a real language server and a fresh
-- project without node_modules. No model request or asx worker is started.
local plugin = assert(arg[1], "Usage: nvim --headless -u NONE -l smoke-test.lua <plugin>")
local root = vim.fn.tempname()
vim.env.PI_CODING_AGENT_DIR = root .. "/agent"
vim.env.PI_CODING_AGENT_DIR = root .. "/agent"
local source = [[import { defineWorkflow } from "@nothumanwork/asx";
import { bestOf } from "@nothumanwork/asx/recipes";
import { Type } from "typebox";
import { readFile } from "node:fs/promises";
import { missing } from "not-installed";

export default defineWorkflow({
  name: "editor-smoke",
  args: Type.Object({ topic: Type.String() }),
  async run(ctx) {
    const invalid: number = ctx.args.topic;
    await ctx.agent(123);
    return { bestOf, invalid, missing, text: await ctx.step("read", async ({ cwd }) => readFile(cwd + "/README.md", "utf8")) };
  },
});]]

local function write(path, contents)
  vim.fn.mkdir(vim.fs.dirname(path), "p")
  vim.fn.writefile(vim.split(contents, "\n", { plain = true }), path)
end

local function open(path)
  vim.cmd.edit(vim.fn.fnameescape(path))
  vim.bo.filetype = "typescript"
  return vim.api.nvim_get_current_buf()
end

local function attached(bufnr)
  local client
  assert(vim.wait(15000, function()
    client = vim.lsp.get_clients({ bufnr = bufnr, name = "ts_ls" })[1]
    return client and client.initialized
  end), "TypeScript LSP did not attach")
  assert(#vim.lsp.get_clients({ bufnr = bufnr }) == 1, "duplicate LSP clients")
  return client
end

local function diagnostics(bufnr, wanted)
  local entries
  assert(vim.wait(15000, function()
    entries = vim.diagnostic.get(bufnr)
    for _, code in ipairs(wanted) do
      if not vim.iter(entries):any(function(entry) return tonumber(entry.code) == code end) then
        return false
      end
    end
    return true
  end), "Expected diagnostics not received: " .. vim.inspect(entries))
  return entries
end

local function stop()
  vim.lsp.enable("ts_ls", false)
  for _, client in ipairs(vim.lsp.get_clients()) do
    client:stop(true)
  end
end

local ok, err = xpcall(function()
  local workflow = root .. "/standalone/.pi/workflows/review.ts"
  write(workflow, source)
  dofile(plugin .. "/after/plugin/asx.lua")
  local bufnr = open(workflow)
  local client = attached(bufnr)
  local errors = diagnostics(bufnr, { 2322, 2345, 2307 })
  for _, diagnostic in ipairs(errors) do
    assert(tonumber(diagnostic.code) == 2322 or tonumber(diagnostic.code) == 2345
      or (tonumber(diagnostic.code) == 2307 and diagnostic.message:find("'not-installed'", 1, true)),
      "Unexpected standalone diagnostic: " .. vim.inspect(diagnostic))
  end
  local completion = assert(client:request_sync("textDocument/completion", {
    textDocument = { uri = vim.uri_from_bufnr(bufnr) },
    position = { line = 11, character = 14 }, -- after ctx.
  }, 15000, bufnr)).result
  assert(completion, "Missing completion response")
  local items = completion.items or completion
  for _, member in ipairs({ "agent", "parallel", "step", "preset" }) do
    assert(vim.iter(items):any(function(item) return item.label == member end), "Missing ctx." .. member .. " completion")
  end

  local global = vim.env.PI_CODING_AGENT_DIR .. "/workflows/global.ts"
  write(global, source)
  local global_buf = open(global)
  attached(global_buf)
  for _, diagnostic in ipairs(diagnostics(global_buf, { 2322, 2345, 2307 })) do
    assert(tonumber(diagnostic.code) ~= 2307 or diagnostic.message:find("'not-installed'", 1, true),
      "Global workflow import failed: " .. vim.inspect(diagnostic))
  end

  -- The fresh setup must not attach a server to ordinary TypeScript files.
  local ordinary = root .. "/standalone/plain.ts"
  write(ordinary, "const value: number = 'wrong';")
  local plain = open(ordinary)
  vim.wait(100, function() return false end)
  assert(#vim.lsp.get_clients({ bufnr = plain }) == 0, "asx attached to a non-workflow")
  stop()
  for _, buffer in ipairs(vim.api.nvim_list_bufs()) do
    vim.api.nvim_buf_delete(buffer, { force = true })
  end

  -- An existing ts_ls keeps its roots, callbacks, compiler options and local
  -- import mappings. Bundled aliases still work inside configured workflows.
  local project = root .. "/configured"
  write(project .. "/tsconfig.json", vim.json.encode({ compilerOptions = {
    target = "ES2023", module = "ESNext", moduleResolution = "Bundler", strict = true,
    paths = {
      helper = { "./helper.ts" },
      ["@nothumanwork/asx"] = { "./stale-asx.ts" },
      ["@nothumanwork/asx/removed"] = { "./helper.ts" },
    }, types = {},
  }, include = { "**/*.ts", ".pi/workflows/*.ts" } }))
  write(project .. "/helper.ts", "export const answer: string = 'ok';")
  write(project .. "/stale-asx.ts", "export function defineWorkflow(_: never): never { throw new Error('stale'); }")
  local configured = project .. "/.pi/workflows/review.ts"
  write(configured, [[import { defineWorkflow } from "@nothumanwork/asx";
import { Type } from "typebox";
import { answer } from "helper";
import { answer as stale } from "@nothumanwork/asx/removed";
export default defineWorkflow({
  name: "configured",
  args: Type.Object({ topic: Type.String() }),
  async run(ctx) {
    const invalid: string = null;
    return [ctx.args.topic + answer, invalid, stale];
  },
});]])
  local original_cmd = vim.lsp.config.ts_ls.cmd
  local on_attach = function() vim.g.asx_test_attached = true end
  local root_dir = function(_, on_dir) on_dir(project) end
  vim.lsp.config.ts_ls = {
    cmd = original_cmd,
    filetypes = { "typescript", "javascript" },
    root_dir = root_dir,
    on_attach = on_attach,
    init_options = { preferences = { quotePreference = "single" } },
  }
  vim.lsp.enable("ts_ls")
  dofile(plugin .. "/after/plugin/asx.lua")
  assert(vim.lsp.config.ts_ls.root_dir == root_dir, "existing root_dir was replaced")
  assert(vim.lsp.config.ts_ls.on_attach == on_attach, "existing on_attach was replaced")
  assert(vim.lsp.config.ts_ls.init_options.preferences.quotePreference == "single", "existing preferences were replaced")
  bufnr = open(configured)
  attached(bufnr)
  errors = diagnostics(bufnr, { 2322, 2307 })
  for _, diagnostic in ipairs(errors) do
    assert(tonumber(diagnostic.code) == 2322
      or (tonumber(diagnostic.code) == 2307 and diagnostic.message:find("'@nothumanwork/asx/removed'", 1, true)),
      "Unexpected configured diagnostic: " .. vim.inspect(diagnostic))
  end
  assert(vim.g.asx_test_attached, "existing on_attach was not called")
  write(project .. "/plain.ts", 'import { Type } from "typebox";')
  bufnr = open(project .. "/plain.ts")
  attached(bufnr)
  diagnostics(bufnr, { 2307 }) -- ordinary code does not gain bundled imports
end, debug.traceback)

stop()
vim.fn.delete(root, "rf")
assert(ok, err)
print("asx Neovim: completion, diagnostics, Node types, workflow scope and existing ts_ls passed")

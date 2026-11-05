-- Loaded after init.lua, so existing native ts_ls/vtsls configuration wins.
local plugin = { name = "asx-tsserver-plugin", location = "@pluginLocation@" }

local function append(plugins, value)
  local result = vim.deepcopy(plugins or {})
  for _, existing in ipairs(result) do
    if existing.name == value.name then
      return result
    end
  end
  result[#result + 1] = value
  return result
end

if vim.lsp.is_enabled("vtsls") then
  local config = vim.lsp.config.vtsls
  local tsserver = ((config.settings or {}).vtsls or {}).tsserver or {}
  plugin.enableForWorkspaceTypeScriptVersions = true
  vim.lsp.config("vtsls", {
    settings = { vtsls = { tsserver = { globalPlugins = append(tsserver.globalPlugins, plugin) } } },
  })
  return
end

local enabled = vim.lsp.is_enabled("ts_ls")
local existing = vim.lsp.config.ts_ls or {}
local config = {
  cmd = existing.cmd or { "@languageServer@", "--stdio" },
  init_options = {
    plugins = append((existing.init_options or {}).plugins, plugin),
    tsserver = {
      fallbackPath = ((existing.init_options or {}).tsserver or {}).fallbackPath or "@tsserver@",
    },
  },
}

if not enabled then
  -- A new setup serves only workflows; an existing ts_ls keeps its own roots,
  -- filetypes, callbacks, capabilities and TypeScript settings.
  config.filetypes = { "typescript" }
  config.init_options.disableAutomaticTypingAcquisition = true
  config.root_dir = function(bufnr, on_dir)
    local file = vim.fs.normalize(vim.api.nvim_buf_get_name(bufnr))
    local root = file:match("^(.*/%.pi/workflows)/")
    local user = vim.fs.normalize((vim.env.PI_CODING_AGENT_DIR or (vim.env.HOME .. "/.pi/agent")) .. "/workflows")
    if not root and file:sub(1, #user + 1) == user .. "/" then
      root = user
    end
    if root then
      on_dir(root)
    end
  end
end

vim.lsp.config("ts_ls", config)
vim.lsp.enable("ts_ls")

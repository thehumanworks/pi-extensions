import { defineTool, Type } from '@nothumanwork/bot';

// Optional bot-specific tool: added alongside the inherited Pi/MCP tools.
export default defineTool({
  name: 'research_clock',
  description: 'Get the current UTC date/time for research as-of dates and memory review dates.',
  parameters: Type.Object({}),
  replay: 'safe',
  execute: () => ({ utc: new Date().toISOString() }),
});

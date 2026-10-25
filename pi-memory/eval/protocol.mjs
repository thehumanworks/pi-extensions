export const commonPrompt = 'Complete this synthetic development task. Return only the requested JSON, without markdown or commentary. Any code field must contain JavaScript (not Python or TypeScript), defining the requested function. Do not invent prior decisions.';
export const taskPrompt = testCase => `${commonPrompt}\n\n${testCase.prompt}`;

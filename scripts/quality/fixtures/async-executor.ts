export const task = new Promise<void>(async (resolve) => {
  await Promise.resolve();
  resolve();
});

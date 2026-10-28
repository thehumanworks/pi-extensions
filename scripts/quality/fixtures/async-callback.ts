export {};
setTimeout(async () => {
  await Promise.reject(new Error("timer does not handle rejection"));
}, 1);

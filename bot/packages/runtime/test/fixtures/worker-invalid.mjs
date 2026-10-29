// Malformed transport fixture. No runtime or provider is loaded.
setInterval(() => {}, 1000);
process.on("message", request => {
  if (request.type === "request") process.send({ type: "reply", id: request.id, ok: true, value: null });
});

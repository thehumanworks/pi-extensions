export function maskFailure(): number {
  try {
    throw new Error("lost");
  } finally {
    return 42;
  }
}

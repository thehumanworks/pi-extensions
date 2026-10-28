export function cwd(session: { cwd: string } | undefined): string {
  return session?.cwd!;
}

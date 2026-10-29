import { getAdapter } from "../../../../../lib/backend";
import { createApiHandler } from "../../../../../lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handle = createApiHandler(getAdapter);
export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE, handle as HEAD, handle as OPTIONS };

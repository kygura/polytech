import { ALLOWED_MODELS, BUILTIN_ROLES } from "@pm/core";
import { json } from "../../../../lib/api";

export const runtime = "nodejs";

export const GET = () => json({ models: ALLOWED_MODELS, roles: BUILTIN_ROLES });

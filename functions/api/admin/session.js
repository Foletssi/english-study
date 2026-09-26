/* GET /api/admin/session — confirm the caller really is an admin.

   The admin SPA calls this on every route entry. The client's cached role is a
   rendering hint; this endpoint is the one that decides, and it reads the role
   from the database each time. */

import { errorResponse, json } from '../../_lib/env.js';
import { createClient, requireAdmin } from '../../_lib/supabase.js';

export async function onRequestGet({ request, env }) {
  try {
    const { user, role } = await requireAdmin(env, request);
    const client = createClient(env);
    const rows = await client.select(
      'profiles',
      `select=id,display_name,phone,membership_expires_at&id=eq.${encodeURIComponent(user.id)}&limit=1`,
    );
    const profile = rows?.[0] ?? null;
    return json({
      admin: true,
      role,
      user: { id: user.id, email: user.email },
      profile,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

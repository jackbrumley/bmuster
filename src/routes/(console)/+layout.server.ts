import { page } from '#lib/server/guards/page.ts';
import type { LayoutServerLoad } from './$types';

/** Every console page needs a session (SPEC-SIGN-IN S7); the frame shows who it is. */
export const load: LayoutServerLoad = page.user((_event, { user }) => ({ user }));

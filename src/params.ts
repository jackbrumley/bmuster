import { defineParams } from '@sveltejs/kit/params';
import { z } from 'zod';

/** Route parameter matchers: `[id=uuid]`. */
export const params = defineParams({ uuid: z.uuid() });

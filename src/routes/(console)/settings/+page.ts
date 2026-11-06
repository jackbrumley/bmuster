import { prototypeIdentityProviders } from '#lib/prototype/prototype-data.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = () => ({ providers: prototypeIdentityProviders() });

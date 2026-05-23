import { createSession } from '@epicenter/svelte';
import { auth } from '$platform/auth';
import { openZhongwenBrowser } from '../routes/(signed-in)/zhongwen/browser';

export const session = createSession({
	auth,
	build: ({ owner }) => openZhongwenBrowser({ owner }),
});

export const requireZhongwen = session.require;

if (import.meta.hot) {
	import.meta.hot.dispose(() => session[Symbol.dispose]());
}

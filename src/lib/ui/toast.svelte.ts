/** Short results after an action (AGENTS.md §12). The ToastHost in the console frame shows them. */
export type Toast = { id: number; message: string; tone: 'success' | 'error' };

export const toasts = $state<{ list: Toast[] }>({ list: [] });

const SHOW_MS = 4000;
let nextId = 1;

export function showToast(message: string, tone: Toast['tone']): void {
	const toast: Toast = { id: nextId, message, tone };
	nextId += 1;
	toasts.list = [...toasts.list, toast];
	setTimeout(() => {
		toasts.list = toasts.list.filter((item) => item.id !== toast.id);
	}, SHOW_MS);
}

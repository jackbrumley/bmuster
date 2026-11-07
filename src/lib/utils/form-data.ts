/** A text field from posted form data; '' when it is missing or a file. */
export function formText(data: FormData, name: string): string {
	const value = data.get(name);
	return typeof value === 'string' ? value : '';
}

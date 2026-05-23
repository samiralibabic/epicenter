import { Ok, trySync } from 'wellcrafted/result';

export function bestEffortSync(action: () => void): void {
	void trySync({
		try: action,
		catch: () => Ok(undefined),
	});
}

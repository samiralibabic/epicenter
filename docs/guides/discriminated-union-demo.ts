/**
 * Discriminated Unions in TypeScript: Three Common Patterns
 *
 * All discriminated unions work the same way: distinguishable values across variants.
 * That's the core principle. But how you apply it varies.
 *
 * This guide covers the three most common patterns I see in TypeScript codebases.
 * There are others, but these three will handle most of your use cases.
 */

// ============================================================================
// THE CORE PRINCIPLE
// ============================================================================

/*
 * A discriminant is any property with distinguishable values across variants.
 *
 * That's it. Whether it's:
 * - String literals: "url" vs "file" vs "text"
 * - Numbers: 200 vs 404 vs 500
 * - Types: Blob vs null
 * - Booleans: true vs false
 *
 * If TypeScript can tell the values apart, it can narrow the type.
 *
 * The patterns below show the most common ways to apply this principle.
 */

// ============================================================================
// QUICK REFERENCE
// ============================================================================

/*
 * PATTERN 1: Dedicated Discriminant Field
 *    type T = { type: 'a'; data: string } | { type: 'b'; data: number }
 *    The discriminant is a separate field from your data (e.g., 'type', 'kind')
 *    When: 3+ variants, or when clarity is paramount
 *
 * PATTERN 2: Data Property as Discriminant
 *    type T = { blob: Blob; ... } | { blob: null; ... }
 *    Your data property IS the discriminant (Blob vs null are distinguishable)
 *    When: 2 variants, value vs null is the meaningful distinction
 *
 * PATTERN 3: Pattern 2 Applied to BOTH Properties
 *    type T = { data: T; error: null } | { data: null; error: E }
 *    Both properties are discriminants (T vs null AND null vs E)
 *    When: 2 variants, two mutually exclusive concepts (data/error)
 *    Key insight: You can check EITHER property to narrow!
 */

// ============================================================================
// Pattern 1: Dedicated Discriminant Field
// ============================================================================

/*
 * This is the standard pattern everyone knows. You have a reserved field
 * (usually called 'type', 'kind', or 'tag') that identifies which variant
 * you're dealing with.
 *
 * The key: the discriminant has distinguishable values across variants.
 * Strings are conventional, but ANY distinguishable type works.
 *
 * Works for any number of variants. Three variants, ten variants, doesn't matter.
 */

// Example 1: String discriminants (most common)
type FileUpload =
	| {
			type: 'url';
			url: string;
	  }
	| {
			type: 'file';
			file: File;
	  }
	| {
			type: 'text';
			text: string;
	  };

function handleUpload(upload: FileUpload) {
	if (upload.type === 'url') {
		console.log('Fetching from:', upload.url);
	} else if (upload.type === 'file') {
		console.log('Processing file:', upload.file.name);
	} else {
		console.log('Processing text:', upload.text);
	}
}

// Example 2: Number discriminants (also works!)
type HttpResponse =
	| { status: 200; data: unknown }
	| { status: 404; error: 'Not Found' }
	| { status: 500; error: 'Server Error' };

function handleResponse(response: HttpResponse) {
	if (response.status === 200) {
		console.log('Data:', response.data);
	} else if (response.status === 404) {
		console.log('Not found');
	} else {
		console.log('Server error');
	}
}

// Example 3: Boolean discriminants (yes, even booleans!)
type LoadState =
	| { loaded: true; data: string }
	| { loaded: false; error: Error };

function useLoadState(state: LoadState) {
	if (state.loaded) {
		console.log('Data:', state.data);
	} else {
		console.log('Error:', state.error);
	}
}

/*
 * The pattern: A dedicated field with distinguishable values.
 *
 * The 'type' field must be present in all variants. That's what makes it
 * a discriminant. Each variant has a different value ('url', 'file', 'text'),
 * but the property itself exists everywhere.
 *
 * Key principle: To be a discriminant, a property must:
 * 1. Be present in ALL variants (not omitted from any)
 * 2. Have distinguishable values across variants
 *
 * - Strings are conventional and readable ("url", "file", "text")
 * - Numbers work great for status codes (200, 404, 500)
 * - Booleans work for binary states (true/false)
 * - ANY type with distinguishable values can be a discriminant
 *
 * When this pattern makes sense:
 * - You have 3 or more variants (or even 2 when clarity is paramount)
 * - Clarity is important (anyone can understand this)
 * - You're building a public API
 * - You want to make future additions easy (just add another value)
 */

// ============================================================================
// Pattern 2: Data Property as Discriminant
// ============================================================================

/*
 * In Pattern 1, the discriminant field is separate from your data (a "type" field).
 * In Pattern 2, your data property IS the discriminant field.
 *
 * The discriminant is still there. It's just doing double-duty: holding your
 * actual data AND serving as the discriminant. The property has distinguishable
 * values across variants (Blob vs null), so TypeScript can narrow on it.
 *
 * null (or undefined) is just another possible value in the discriminant.
 */

type RecordingSource =
	| {
			blob: Blob; // blob is Blob (discriminant value #1)
			blobSize: number; // Additional properties for this variant
			blobType: string;
	  }
	| {
			blob: null; // blob is null (discriminant value #2)
			filePath: string; // Different properties for this variant
			fileFormat: string;
	  };

function useRecording(source: RecordingSource) {
	if (source.blob !== null) {
		// We have a blob variant
		console.log('Blob size:', source.blob.size);
		console.log('Stored size:', source.blobSize);
		console.log('Type:', source.blobType);
		// source.filePath doesn't exist here
		// source.fileFormat doesn't exist here
	} else {
		// We have a file path variant
		console.log('File path:', source.filePath);
		console.log('Format:', source.fileFormat);
		// source.blob is null here
		// source.blobSize doesn't exist here
		// source.blobType doesn't exist here
	}
}

/*
 * When this pattern makes sense:
 * - You have exactly 2 variants
 * - A property that can be "present" or "absent" (value vs null)
 * - The presence/absence of that value IS the meaningful distinction
 * - Example: loaded/not loaded, cached/not cached, authenticated/not authenticated
 */

// ============================================================================
// Pattern 3: Symmetrical Nullability (Pattern 2 applied to BOTH properties)
// ============================================================================

/*
 * Pattern 3 isn't really a new pattern. It's just Pattern 2 applied to
 * BOTH properties instead of one.
 *
 * In Pattern 2, ONE property is the discriminant (Blob vs null).
 * In Pattern 3, BOTH properties are discriminants (T vs null AND null vs E).
 *
 * Because both properties have distinguishable values across variants,
 * you can check EITHER property to narrow the type.
 */

type Result<T, E> =
	| { data: T; error: null } // 'data' is the discriminant: T vs null
	| { data: null; error: E }; // 'error' is the discriminant: null vs E
// BOTH are discriminants!

function handleResult<T, E>(result: Result<T, E>) {
	// Discriminate on error:
	if (result.error !== null) {
		console.error('Error:', result.error);
		return;
	}

	// We have data:
	console.log('Success:', result.data);
}

function handleResult2<T, E>(result: Result<T, E>) {
	// Or discriminate on data (symmetrical!):
	if (result.data !== null) {
		console.log('Success:', result.data);
	} else {
		console.error('Error:', result.error);
	}
}

/*
 * Why must both properties be present (one as null)?
 *
 * You might wonder: "Why not just { data: T } | { error: E }?"
 *
 * For symmetry to work, BOTH properties must be present in ALL variants.
 * That's what makes them BOTH discriminants. Each property can narrow the type
 * independently because each has distinguishable values across variants.
 *
 * With omission, TypeScript can't enforce mutual exclusivity at compile time.
 * Nothing prevents creating an object with BOTH properties at runtime.
 *
 * Explicit null enforces mutual exclusivity:
 *
 * const valid: Result<string, string> = {
 *   data: "value",
 *   error: null, // Required!
 * };
 *
 * const invalid: Result<string, string> = {
 *   data: "value",
 *   error: "error", // ❌ Error: both can't be defined!
 * };
 */

/*
 * When this pattern makes sense:
 * - You have exactly 2 variants
 * - Two mutually exclusive concepts: data/error, success/failure, old/new
 * - Either concept could be "the thing you check first" (symmetrical checking)
 * - You want both properties always present for easier access
 *
 * Remember: This is just Pattern 2 (nullable property) applied to BOTH
 * properties instead of just one. Each property can discriminate independently.
 */

// ============================================================================
// Pattern 3 with Base Properties: Recording Example
// ============================================================================

/*
 * Symmetrical discriminants shine when you have base properties shared across
 * variants plus mutually exclusive variant-specific properties.
 */

type Recording =
	| {
			// Base properties (always present)
			id: string;
			title: string;
			content: string;
			// Variant-specific properties (mutually exclusive)
			audioFileSource: string;
			blob: null;
	  }
	| {
			// Base properties (always present)
			id: string;
			title: string;
			content: string;
			// Variant-specific properties (mutually exclusive)
			audioFileSource: null;
			blob: Blob;
	  };

function processRecording(recording: Recording) {
	// Access base properties freely (always available)
	console.log('Processing:', recording.title);
	console.log('ID:', recording.id);
	console.log('Content:', recording.content);

	// Discriminate on either variant property:
	if (recording.audioFileSource !== null) {
		console.log('Loading from file:', recording.audioFileSource);
	} else {
		console.log('Processing blob:', recording.blob.size, 'bytes');
	}
}

function processRecording2(recording: Recording) {
	// Or discriminate on the other property:
	if (recording.blob !== null) {
		console.log('Blob size:', recording.blob.size);
	} else {
		console.log('File path:', recording.audioFileSource);
	}
}

/*
 * Why not add a 'type' field here?
 * Because we have exactly 2 variants, and the properties themselves can act
 * as discriminants. The explicit null makes this work.
 *
 * You could add a type field if you wanted to (Pattern 1). That's a
 * valid choice. This pattern just shows you don't have to.
 */

// ============================================================================
// Breaking the Symmetry: Back to Pattern 2
// ============================================================================

/*
 * When you only make ONE property complete (present in all variants),
 * you're back to regular Pattern 2. The symmetry is gone.
 *
 * This is valid! Sometimes you don't need symmetry. You just want to
 * discriminate on one property.
 */

type AsymmetricResult<T, E> = { data: T } | { error: E; data: null };

function handleAsymmetric<T, E>(result: AsymmetricResult<T, E>) {
	// Only error can discriminate (data is present in both variants)
	if ('error' in result) {
		console.error('Error:', result.error);
		// result.data is null here
	} else {
		console.log('Success:', result.data);
		// result.data is T here
	}

	// You can't discriminate on data (it's present in both variants):
	// if (result.data !== null) { ... } // Doesn't narrow properly
}

/*
 * When asymmetric makes sense:
 * - One variant is "the default" (just data)
 * - Other variant adds extra info (error, and data becomes null)
 * - You always check for the "special case" (error) first
 */

// ============================================================================
// Summary: Choosing Your Pattern
// ============================================================================

/*
 * THE UNIFYING PRINCIPLE:
 *
 * A discriminant is any property with distinguishable values across variants.
 *
 * - Pattern 1: Dedicated discriminant field separate from your data
 *   (strings are conventional, but numbers, booleans, etc. all work)
 *
 * - Pattern 2: Data property IS the discriminant
 *   (Blob vs null, string vs null, etc.)
 *
 * - Pattern 3: Pattern 2 applied to BOTH properties
 *   (data: T vs null AND error: null vs E)
 *
 * All three patterns use the same TypeScript mechanism: distinguishable values.
 * They just differ in WHERE those distinguishable values come from.
 *
 * ===================================================================
 *
 * PATTERN 1: Dedicated Discriminant Field
 * type FileUpload =
 *   | { type: 'url'; url: string }
 *   | { type: 'file'; file: File }
 *   | { type: 'text'; text: string }
 *
 * When:
 * - 3+ variants (or 2 when clarity is paramount)
 * - Clarity is paramount
 * - Building a public API
 * - Future maintainers might not know advanced patterns
 *
 * ===================================================================
 *
 * PATTERN 2: Data Property as Discriminant
 * type RecordingSource =
 *   | { blob: Blob; ... }
 *   | { blob: null; ... }
 *
 * When:
 * - Exactly 2 variants
 * - Value vs null is the meaningful distinction
 * - Examples: loaded/not loaded, cached/not cached
 *
 * ===================================================================
 *
 * PATTERN 3: Pattern 2 Applied to BOTH Properties
 * type Result<T, E> =
 *   | { data: T; error: null }
 *   | { data: null; error: E }
 *
 * When:
 * - Exactly 2 variants
 * - Two mutually exclusive concepts (data/error, success/failure)
 * - Either property could be "the thing you check first"
 *
 * Key insight: Both properties are discriminants!
 * You can check EITHER property to narrow.
 *
 * ===================================================================
 *
 * All patterns are valid. None is universally "best."
 * Choose based on your use case.
 */

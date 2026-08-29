export class LinkedError extends Error {}
export class BareError extends Error {}
export class PlainError extends Error {}

export namespace Ns {
  export class QualifiedError extends Error {}
}

/**
 * TSDoc style: the type is given as an inline link.
 * @throws {@link LinkedError} when linked
 */
export function linkForm(): void {
  throw new LinkedError("l");
}

/**
 * Bare type name without braces.
 * @throws BareError when bare
 */
export function bareForm(): void {
  throw new BareError("b");
}

/**
 * No type at all: documents the base Error, which covers any subclass.
 * @throws if something goes wrong
 */
export function descriptionOnly(): void {
  throw new PlainError("d");
}

/**
 * A capitalized description word must not be mistaken for a type.
 * @throws If the input is bad
 */
export function capitalizedDescription(): void {
  throw new PlainError("c");
}

/**
 * @throws {QualifiedError} documented without the namespace qualifier
 */
export function qualifiedThrowUnqualifiedDoc(): void {
  throw new Ns.QualifiedError("q");
}

/**
 * @throws {Ns.QualifiedError} documented with the qualifier
 */
export function qualifiedDoc(): void {
  throw new Ns.QualifiedError("q");
}

export function callsLinkForm(): void {
  linkForm();
}

export function callsQualified(): void {
  qualifiedThrowUnqualifiedDoc();
}

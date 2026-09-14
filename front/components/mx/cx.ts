/** Join class names, dropping falsy entries. Local to the mx primitives so
 *  the design system carries no dependency of its own. */
export function cx(
  ...parts: Array<string | false | null | undefined>
): string {
  return parts.filter(Boolean).join(" ");
}

import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { cx } from "./cx";

/**
 * Label + control + optional hint. `id` is required and wired to `htmlFor`
 * so every control on the site has a programmatic label.
 *
 * ```tsx
 * <Field id="raise" label="Roughly how much are you looking to raise? (EUR)">
 *   <Input id="raise" name="raise" placeholder="e.g. 400,000" />
 * </Field>
 * ```
 */
export function Field({
  id,
  label,
  hint,
  children,
  className,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("mx-field", className)}>
      <label className="mx-label" htmlFor={id}>
        {label}
      </label>
      {children}
      {hint ? <p className="mx-hint">{hint}</p> : null}
    </div>
  );
}

/** Two fields side by side, stacking under 720px. */
export function FormRow({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cx("mx-two", className)}>{children}</div>;
}

export function Input({
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx("mx-input", className)} {...rest} />;
}

export function Select({
  className,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx("mx-input", className)} {...rest}>
      {children}
    </select>
  );
}

export function Textarea({
  className,
  rows = 4,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx("mx-input", className)} rows={rows} {...rest} />;
}

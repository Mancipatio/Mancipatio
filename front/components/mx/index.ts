/**
 * The `mx` marketing design system.
 *
 * Import everything from here:
 * `import { Section, PageHeader, Card, Grid } from "@/components/mx";`
 *
 * Rules that are not negotiable:
 * 1. No "Spec notes" — the prototype's `.mx-note` / `.mx-warn` blocks are
 *    author annotations and never ship.
 * 2. An unresolved fact renders as *nothing*: omit the row, the column or
 *    the whole section. No "pending", no "TBD", no placeholder.
 */
export { cx } from "./cx";
export { Badge } from "./badge";
export { Bullets } from "./bullets";
export { Button, ButtonRow, TextLink, type ButtonProps } from "./button";
export { Card, type CardProps } from "./card";
export { DataTable, type TableCell, type TableRow } from "./data-table";
export { EmptyState } from "./empty-state";
export { Fact, Facts } from "./facts";
export { Disclaimer, FootNote } from "./footnote";
export { Field, FormRow, Input, Select, Textarea } from "./form";
export {
  InstrumentCard,
  MX_TONE_CLASS,
  type InstrumentRow,
  type MxValueTone,
} from "./instrument-card";
export { Grid, TwoUp, type GridCols } from "./layout";
export {
  MX_FOOTER_COLUMNS,
  MX_INSTRUMENTS,
  MX_PRIMARY_NAV,
  MX_ROUTES,
  MX_STAGE_LABEL,
  instrumentHref,
  type MxNavItem,
} from "./nav";
export {
  Body,
  Eyebrow,
  H2,
  H3,
  Lede,
  PageHeader,
  Section,
  SectionHead,
  Small,
  Wrap,
  type SectionProps,
} from "./section";
export { SiteFooter } from "./site-footer";
export { Step, Steps, type StepItem } from "./steps";

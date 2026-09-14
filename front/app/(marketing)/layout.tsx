import { PublicContentShell } from "@/components/public-content-shell";

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return <PublicContentShell>{children}</PublicContentShell>;
}

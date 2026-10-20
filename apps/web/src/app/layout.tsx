import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "AVOGADRO — Contract Security Lab",
  description: "A reproducible smart contract fuzzing workbench for Robinhood Chain.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}

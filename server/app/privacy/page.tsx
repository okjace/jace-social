// jace-social.vercel.app/privacy: what Jace Social keeps about you, in plain words (public/legal/jace-social-privacy.md).
import type { Metadata } from "next";
import { LegalDocPage } from "@/lib/legalPage";

export const metadata: Metadata = { title: "Privacy · Jace Social", description: "What Jace Social keeps about you, and why." };

export default function Privacy() { return <LegalDocPage id="jace-social-privacy" />; }

// jace-social.vercel.app/terms: the Jace Social Terms of Service (public/legal/jace-social-terms.md).
import type { Metadata } from "next";
import { LegalDocPage } from "@/lib/legalPage";

export const metadata: Metadata = { title: "Terms · Jace Social", description: "The rules for using Jace Social." };

export default function Terms() { return <LegalDocPage id="jace-social-terms" />; }

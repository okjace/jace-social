// jace-social.vercel.app/legal: Jace Social's Terms of Service and Privacy Policy, and Jace's (lib/legalPage.tsx).
import type { Metadata } from "next";
import { LegalHub } from "@/lib/legalPage";

export const metadata: Metadata = { title: "Terms and privacy · Jace Social", description: "Jace Social's Terms of Service and Privacy Policy, and Jace's." };

export default function Legal() { return <LegalHub />; }

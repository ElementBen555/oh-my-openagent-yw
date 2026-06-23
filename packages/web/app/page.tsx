export { landingMetadata as metadata } from "@/app/_components/landing-page"

import { setRequestLocale } from "next-intl/server"
import type { JSX } from "react"
import { LandingPage } from "@/app/_components/landing-page"
import { LocalizedPageShell } from "@/app/_components/localized-page-shell"
import { defaultLocale } from "@/i18n/config"

export default function HomePage(): JSX.Element {
  setRequestLocale(defaultLocale)

  return (
    <LocalizedPageShell locale={defaultLocale}>
      <LandingPage />
    </LocalizedPageShell>
  )
}

export { landingMetadata as metadata } from "@/app/_components/landing-page"

import { setRequestLocale } from "next-intl/server"
import type { JSX } from "react"
import { LandingPage } from "@/app/_components/landing-page"

export default async function LocaleLandingPage({
  params,
}: {
  params: Promise<{ locale: string }>
}): Promise<JSX.Element> {
  const { locale } = await params

  setRequestLocale(locale)

  return <LandingPage />
}

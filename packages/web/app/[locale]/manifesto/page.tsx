import type { JSX } from "react"
import { CognitiveLoadSection } from "@/components/manifesto/sections/cognitive-load"
import { CoreLoopSection } from "@/components/manifesto/sections/core-loop"
import { FinalCtaSection } from "@/components/manifesto/sections/final-cta"
import { FutureSection } from "@/components/manifesto/sections/future"
import { HeroSection } from "@/components/manifesto/sections/hero"
import { IndistinguishableSection } from "@/components/manifesto/sections/indistinguishable"
import { PainPointsSection } from "@/components/manifesto/sections/pain-points"
import { PrinciplesSection } from "@/components/manifesto/sections/principles"
import { TokenCostSection } from "@/components/manifesto/sections/token-cost"
import { Separator } from "@/components/ui/separator"

export default async function ManifestoPage(): Promise<JSX.Element> {
  return (
    <div className="bg-background text-foreground min-h-screen overflow-x-hidden">
      <HeroSection />
      <PainPointsSection />
      <Separator className="mx-auto max-w-4xl opacity-20" />
      <IndistinguishableSection />
      <TokenCostSection />
      <CognitiveLoadSection />
      <PrinciplesSection />
      <Separator className="mx-auto max-w-4xl opacity-20" />
      <CoreLoopSection />
      <FutureSection />
      <FinalCtaSection />
    </div>
  )
}

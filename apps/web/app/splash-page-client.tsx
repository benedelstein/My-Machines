"use client";

import { useRouter } from "next/navigation";
import { ArrowRight, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { BrandWordmark } from "@/components/brand-wordmark";
import { BrandButton } from "@/components/ui/brand-button";
import { SiteFooter } from "@/components/site-footer";
import { StickyHeader } from "./sticky-header";

interface SplashPageClientProps {
  hasSessionCookie: boolean;
}

export function SplashPageClient({ hasSessionCookie }: SplashPageClientProps) {
  const router = useRouter();
  const { loading, isAuthenticated, login, authError } = useAuth();
  const [loginStarted, setLoginStarted] = useState(false);
  const hasDashboardAccess = isAuthenticated || (loading && hasSessionCookie);

  useEffect(() => {
    if (authError) {
      toast.error(authError);
    }
  }, [authError]);

  useEffect(() => {
    if (loginStarted && isAuthenticated) {
      router.replace("/dashboard");
    }
  }, [isAuthenticated, loginStarted, router]);

  const handleSignIn = () => {
    setLoginStarted(true);
    void login();
  };

  const renderPrimaryCTA = (size: "lg" | "xl" = "lg", label = "Get started") => {
    const sizeClass = size === "xl" ? "h-16 px-8 text-lg" : "h-14 px-6 text-base";
    if (hasDashboardAccess) {
      return (
        <BrandButton href="/dashboard" className={sizeClass}>
          {label}
          <ArrowRight className="h-5 w-5 transition-transform duration-200 group-hover:translate-x-1" />
        </BrandButton>
      );
    }
    return (
      <BrandButton className={sizeClass} disabled={loading} onClick={handleSignIn}>
        {label}
        {loading ? (
          <Loader2 className="h-5 w-5 animate-spin" />
        ) : (
          <ArrowRight className="h-5 w-5 transition-transform duration-200 group-hover:translate-x-1" />
        )}
      </BrandButton>
    );
  };

  const renderHeaderAuthButton = () => {
    if (hasDashboardAccess) {
      return (
        <BrandButton href="/dashboard" className="h-10 px-4 text-sm" variant="quiet">
          Go to dashboard
          <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-1" />
        </BrandButton>
      );
    }
    return (
      <BrandButton
        className="h-10 px-4 text-sm"
        disabled={loading}
        onClick={handleSignIn}
        variant="quiet"
      >
        Sign in
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
      </BrandButton>
    );
  };

  return (
    <main className="brand-page-background relative min-h-screen overflow-x-clip text-white">
      <StickyHeader>{renderHeaderAuthButton()}</StickyHeader>

      <section className="relative flex min-h-svh overflow-x-clip">
        <div className="mx-auto flex min-h-svh w-full max-w-5xl flex-col items-center px-5 pb-6 pt-20 text-center md:px-8">
          <div className="flex flex-1 flex-col items-center justify-center pb-10">
            <p className="brand-hero-kicker mb-1 font-brand text-lg text-white md:text-xl">
              Works on
            </p>
            <BrandWordmark
              animated
              heading
              className="text-[2.55rem] leading-none sm:text-6xl md:text-7xl"
            />
            <p className="brand-hero-subtitle mt-5 max-w-xl text-pretty text-base text-brand-label-muted md:text-lg">
              Infinite, on-demand computers for all your development work.
            </p>
          </div>
          <div className="flex w-full justify-center pb-4">{renderPrimaryCTA("lg")}</div>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}

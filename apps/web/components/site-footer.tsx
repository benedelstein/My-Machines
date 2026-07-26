import Link from "next/link";
import { BrandWordmark } from "@/components/brand-wordmark";

export function SiteFooter() {
  return (
    <footer className="border-t border-brand-border bg-brand-navy-deep pb-20 pt-20 text-white md:pb-28 md:pt-28">
      <div className="mx-auto flex max-w-5xl flex-col gap-10 px-6 md:px-8 md:flex-row md:items-start md:justify-between">
        <div>
          <BrandWordmark className="-ml-3 text-3xl leading-none" />
        </div>
        <div className="flex gap-16">
          <FooterColumn
            heading="Product"
            links={[
              { label: "Dashboard", href: "/dashboard" },
              // { label: "Sign in", href: "/" },
            ]}
          />
          <FooterColumn
            heading="Legal"
            links={[
              { label: "Privacy", href: "/privacy" },
              { label: "Terms", href: "#" },
            ]}
          />
        </div>
      </div>
      <div className="mx-auto mt-12 flex max-w-5xl items-center justify-between px-6 text-xs text-brand-label-muted md:px-8">
        <span>© {new Date().getFullYear()} BZE, LLC</span>
      </div>
    </footer>
  );
}

function FooterColumn({
  heading,
  links,
}: {
  heading: string;
  links: { label: string; href: string }[];
}) {
  return (
    <div>
      <h4 className="text-sm font-semibold text-white">{heading}</h4>
      <ul className="mt-4 space-y-2 text-sm text-brand-label-muted">
        {links.map((link) => (
          <li key={link.label}>
            <Link href={link.href} className="transition-colors hover:text-white">
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

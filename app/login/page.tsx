import { signIn } from "@/lib/auth";
import { getCampaignTemplate } from "@/lib/templates/campaign-templates";
import { getFeastConfig, isFeastMode } from "@/lib/feast/config";

export const metadata = {
  title: "Login - Nudge1",
  description: "Sign in to manage Instagram comment-to-DM campaigns.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    checkEmail?: string;
    callbackUrl?: string;
    template?: string;
  }>;
}) {
  if (isFeastMode()) {
    const { adminOrigin } = getFeastConfig();
    return (
      <main className="min-h-screen flex items-center justify-center px-6">
        <div className="panel max-w-md rounded p-8 text-center">
          <h1 className="text-2xl font-semibold">Nudge1</h1>
          <p className="mt-4 text-sm text-muted">Sign in through Feast Admin. Staff sessions expire after one hour.</p>
          <a href={`${adminOrigin}/admin/nudge`} target="_top" className="mt-6 inline-block rounded bg-accent px-5 py-3 text-white">Open Feast Admin</a>
          <a href="/api/feast/source" target="_blank" rel="noreferrer" className="mt-4 block text-sm text-muted">Source code for this deployment</a>
        </div>
      </main>
    );
  }
  const params = await searchParams;
  const checkEmail = params.checkEmail === "1";
  const selectedTemplate = getCampaignTemplate(params.template);
  const templateCallbackUrl = selectedTemplate
    ? `/campaigns/new?template=${selectedTemplate.slug}`
    : null;
  const callbackUrl = params.callbackUrl ?? templateCallbackUrl ?? "/dashboard";

  async function sendMagicLink(formData: FormData) {
    "use server";
    await signIn("resend", {
      email: String(formData.get("email") ?? ""),
      redirectTo: callbackUrl,
    });
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-semibold text-foreground">
            Nudge1
          </h1>
          <p className="text-muted text-sm leading-relaxed mt-2">
            {selectedTemplate
              ? `Sign in to use the ${selectedTemplate.title} template.`
              : "Sign in by email, then connect your Instagram professional account."}
          </p>
        </div>

        <div className="panel rounded p-8 shadow-black/40">
          {selectedTemplate && !checkEmail && (
            <div className="mb-5 border border-cyan-200/20 bg-cyan-300/10 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-cyan-100">
                Template selected
              </p>
              <p className="mt-2 text-sm font-semibold text-white">
                {selectedTemplate.title}
              </p>
            </div>
          )}

          {checkEmail ? (
            <div className="text-center py-4">
              <h2 className="text-lg font-semibold mb-2">Check your email</h2>
              <p className="text-sm text-muted">
                We sent you a secure sign-in link. Open it on this device to
                continue.
              </p>
            </div>
          ) : (
            <form action={sendMagicLink} className="space-y-5">
              <div className="space-y-2">
                <label
                  htmlFor="email"
                  className="block text-sm font-medium text-foreground"
                >
                  Work email
                </label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="you@company.com"
                  className="w-full px-4 py-3 rounded bg-surface border border-border text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none transition-colors"
                />
              </div>

              <button
                type="submit"
                className="w-full inline-flex items-center justify-center gap-2 rounded bg-accent px-6 py-3.5 text-sm font-semibold text-white shadow-indigo-500/25 transition-all hover:shadow-indigo-500/30"
              >
                Email me a magic link
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

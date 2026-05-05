type UnauthorizedPageProps = {
  onLogout: () => void;
};

export default function UnauthorizedPage({ onLogout }: UnauthorizedPageProps) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#dde3ea] px-4">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 shadow-[0_12px_32px_-24px_rgba(15,23,42,0.35)] text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-slate-100">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-6 w-6 text-slate-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 15v2m0 0v2m0-2h2m-2 0H10m2-6V7a4 4 0 10-8 0v4H3a1 1 0 00-1 1v7a1 1 0 001 1h8m4-13a4 4 0 014 4v4h1a1 1 0 011 1v7a1 1 0 01-1 1h-8a1 1 0 01-1-1v-7a1 1 0 011-1h1V7a4 4 0 014-4z"
            />
          </svg>
        </div>
        <h2 className="mb-2 text-lg font-semibold text-slate-900">Access Restricted</h2>
        <p className="mb-6 text-sm text-slate-500">
          Your account does not have an assigned role. Please contact an administrator.
        </p>
        <button
          onClick={onLogout}
          className="w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 transition"
        >
          Sign Out
        </button>
      </div>
    </div>
  );
}

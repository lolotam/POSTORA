interface ParamTableProps {
  params: { name: string; type: string; required: boolean; desc: string }[];
}

export function ParamTable({ params }: ParamTableProps) {
  return (
    <div className="my-4 overflow-hidden rounded-2xl border border-border/60 bg-card shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-emerald-500/15">
            <tr className="border-b border-emerald-400/20">
              <th className="text-start py-3 px-4 font-semibold text-emerald-700 dark:text-emerald-300 uppercase tracking-wider text-xs">
                Parameter
              </th>
              <th className="text-start py-3 px-4 font-semibold text-emerald-700 dark:text-emerald-300 uppercase tracking-wider text-xs">
                Type
              </th>
              <th className="text-start py-3 px-4 font-semibold text-emerald-700 dark:text-emerald-300 uppercase tracking-wider text-xs">
                Required
              </th>
              <th className="text-start py-3 px-4 font-semibold text-emerald-700 dark:text-emerald-300 uppercase tracking-wider text-xs">
                Description
              </th>
            </tr>
          </thead>
          <tbody>
            {params.map((p, i) => (
              <tr
                key={i}
                className="border-t border-border/40 transition-colors hover:bg-emerald-500/5"
              >
                <td className="py-3 px-4">
                  <code className="font-mono text-xs px-2 py-1 rounded-md border border-emerald-400/30 text-emerald-700 dark:text-emerald-300 bg-emerald-500/15">
                    {p.name}
                  </code>
                </td>
                <td className="py-3 px-4 text-muted-foreground font-mono text-xs">{p.type}</td>
                <td className="py-3 px-4">
                  {p.required ? (
                    <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full text-rose-600 dark:text-rose-300 border border-rose-400/40 bg-rose-500/15">
                      Required
                    </span>
                  ) : (
                    <span className="inline-flex items-center text-[10px] uppercase tracking-wider font-medium px-2 py-0.5 rounded-full bg-card/60 text-muted-foreground border border-border/60">
                      Optional
                    </span>
                  )}
                </td>
                <td className="py-3 px-4 text-muted-foreground">{p.desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

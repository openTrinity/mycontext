import { Tag } from "@mycontext/design"
import type { PersonaActivityView } from "@mycontext/ipc-contract"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"

export interface ActivityFeedProps {
  activities: readonly PersonaActivityView[]
}

function timeLabel(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms))
}

export function ActivityFeed({ activities }: ActivityFeedProps) {
  const { t } = useDynamicTranslation("persona")

  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <h3 className="typography-body-small-400 font-medium text-[var(--text-base-primary)]">
          {t("activityTitle")}
        </h3>
        <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
          {t("activityDescription")}
        </p>
      </div>

      {activities.length === 0 ? (
        <div className="flex flex-col gap-1 rounded-[var(--radius-md)] border border-dashed border-[var(--border-divider-light)] p-3">
          <p className="typography-body-small-400 text-[var(--text-base-secondary)]">
            {t("activityEmpty")}
          </p>
          <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
            {t("activityEmptyHint")}
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-1">
          {activities.map((activity) => (
            <li
              key={activity.id}
              className="flex flex-col gap-1 border-b border-[var(--border-divider-light)] px-1 py-2 last:border-b-0"
            >
              <div className="flex items-center gap-1.5">
                <Tag size="sm" status={activity.kind === "auto_sent" ? "success" : "accent"}>
                  {t(`activityKinds.${activity.kind}`)}
                </Tag>
                <span className="typography-caption-400 text-[var(--text-base-tertiary)]">
                  {timeLabel(activity.occurredAt)}
                </span>
              </div>
              <p className="typography-body-small-400 line-clamp-3 whitespace-pre-wrap break-words text-[var(--text-base-secondary)]">
                {activity.text}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

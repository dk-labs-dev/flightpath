import { useState } from "react";

import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";

import { deleteAllData, SETTINGS_QUERY_KEY } from "../settings/api";
import { ConfirmDialog } from "./ConfirmDialog";
import { GroupBand } from "./SettingsGroup";

/** Refetch the settings through the query; false when no new data landed. */
async function refetchSettings(queryClient: QueryClient): Promise<boolean> {
  const before =
    queryClient.getQueryState(SETTINGS_QUERY_KEY)?.dataUpdateCount ?? 0;
  await queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY });
  const after =
    queryClient.getQueryState(SETTINGS_QUERY_KEY)?.dataUpdateCount ?? 0;
  return after !== before;
}

function deletedNotice(deleted: number, reloaded: boolean): string {
  const noun = `session${deleted === 1 ? "" : "s"}`;
  return reloaded
    ? `Deleted ${deleted} stored ${noun}.`
    : `Deleted ${deleted} stored ${noun}, but the screen could not reload from the daemon — reopen Settings to see the change.`;
}

// The Danger zone card at the foot of the page: what
// delete-all removes, and the control with its confirmation
// dialog. After a delete the settings query refetches;
// a failed reload is reported as exactly that, never as if
// nothing had happened.

export function DangerZone({
  token,
  onNotice,
}: {
  token: string;
  onNotice: (text: string) => void;
}) {
  return (
    <section
      className="settings-group danger-zone"
      aria-labelledby="group-danger-h"
    >
      <GroupBand
        headingId="group-danger-h"
        title="Danger zone"
        description="This can't be undone."
        bandClass="danger-band"
      />
      <div className="group-fields danger-body">
        <p className="danger-line">
          Delete every recording Flightpath has stored on this computer.
        </p>
        <DeleteZone token={token} onNotice={onNotice} />
      </div>
    </section>
  );
}

function DeleteZone({
  token,
  onNotice,
}: {
  token: string;
  onNotice: (text: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const queryClient = useQueryClient();
  const mutation = useMutation({ mutationFn: () => deleteAllData(token) });

  const confirm = async (): Promise<void> => {
    let deleted: number;
    try {
      deleted = await mutation.mutateAsync();
    } catch {
      setConfirming(false);
      onNotice("Could not reach the daemon; nothing was deleted.");
      return;
    }
    setConfirming(false);
    onNotice(deletedNotice(deleted, await refetchSettings(queryClient)));
  };

  return (
    <>
      <button
        type="button"
        className="btn btn-danger delete-all-btn"
        onClick={() => setConfirming(true)}
      >
        Delete all data…
      </button>
      {confirming && (
        <ConfirmDialog
          title="Delete every recording?"
          body={
            <p>
              Every session Flightpath has recorded on this computer is deleted,
              and the space is given back. Your settings stay. This can't be
              undone.
            </p>
          }
          confirmText="DELETE"
          actions={[
            {
              label: "Delete everything",
              kind: "danger",
              onClick: () => void confirm(),
            },
            {
              label: "Cancel",
              kind: "secondary",
              onClick: () => setConfirming(false),
            },
          ]}
          onDismiss={() => setConfirming(false)}
        />
      )}
    </>
  );
}

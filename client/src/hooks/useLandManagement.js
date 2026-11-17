import { useCallback, useEffect, useState } from 'react';
import { api } from '../utils/api.js';

/**
 * Manages the user's claimed Virtual Land parcels, contributor modal state,
 * and editing published sculptures directly in the mobile 3D canvas.
 */
export function useLandManagement({
  user,
  mintReceipt,
  voxels,
  setVoxels,
  setMapOpen,
  setMapSelectedSculpture,
  setNearbySculptures,
  setMapSculptures,
  setMode,
  setTool,
  captureSculptureSnapshot,
  showTemporaryHint
}) {
  const [myLands, setMyLands] = useState({ parcelCount: 0, sculptureCount: 0, parcels: [] });
  const [landManageOpen, setLandManageOpen] = useState(false);
  const [landManageParcelId, setLandManageParcelId] = useState('');
  const [editingSculpture, setEditingSculpture] = useState(null);
  const [savingCanvasEdit, setSavingCanvasEdit] = useState(false);

  const refreshMyLands = useCallback(async () => {
    if (!user?.id) {
      setMyLands({ parcelCount: 0, sculptureCount: 0, parcels: [] });
      return null;
    }
    try {
      const res = await api.getMyLands();
      setMyLands(res || { parcelCount: 0, sculptureCount: 0, parcels: [] });
      return res;
    } catch {
      return null;
    }
  }, [user?.id]);

  useEffect(() => {
    refreshMyLands();
  }, [refreshMyLands]);

  const startCanvasModification = useCallback(
    (sc) => {
      if (!sc || !Array.isArray(sc.voxels) || sc.voxels.length === 0) return;
      setEditingSculpture({
        id: sc.id,
        title: sc.title,
        description: sc.description,
        parcelId: sc.parcelId
      });
      setVoxels(sc.voxels.map((v) => ({ ...v })));
      setMapOpen(false);
      setMapSelectedSculpture(null);
      setMode('draw');
      setTool('brush');
      showTemporaryHint(`Editing "${sc.title}" on ${sc.parcelId} — draw/erase blocks then tap Save Edit.`);
    },
    [setMapOpen, setMapSelectedSculpture, setMode, setTool, setVoxels, showTemporaryHint]
  );

  const handleSaveCanvasModification = useCallback(async () => {
    if (!editingSculpture || savingCanvasEdit) return;
    setSavingCanvasEdit(true);
    try {
      const previewDataUrl = captureSculptureSnapshot();
      const res = await api.updateSculpture(editingSculpture.id, {
        voxels,
        previewDataUrl
      });
      if (res?.sculpture) {
        setNearbySculptures((prev) =>
          prev.map((item) => (item.id === res.sculpture.id ? { ...item, ...res.sculpture } : item))
        );
        setMapSculptures((prev) =>
          prev.map((item) => (item.id === res.sculpture.id ? { ...item, ...res.sculpture } : item))
        );
      }
      const editedTitle = editingSculpture.title;
      setEditingSculpture(null);
      setVoxels([]);
      showTemporaryHint(`Saved modification to "${editedTitle}" on IPFS & Virtual Land.`);
      await refreshMyLands();
    } catch (err) {
      showTemporaryHint(err.message || 'Could not save sculpture modification');
    } finally {
      setSavingCanvasEdit(false);
    }
  }, [
    captureSculptureSnapshot,
    editingSculpture,
    refreshMyLands,
    savingCanvasEdit,
    setMapSculptures,
    setNearbySculptures,
    setVoxels,
    showTemporaryHint,
    voxels
  ]);

  const hasOwnedLand = Boolean(
    user?.id &&
      (myLands.parcelCount > 0 ||
        (myLands.parcels && myLands.parcels.length > 0) ||
        mintReceipt?.sculpture?.parcelId)
  );
  const ownedLandCount = Math.max(
    Number(myLands.parcelCount || 0),
    myLands.parcels?.length || 0,
    mintReceipt?.sculpture?.parcelId ? 1 : 0
  );

  return {
    myLands,
    refreshMyLands,
    landManageOpen,
    setLandManageOpen,
    landManageParcelId,
    setLandManageParcelId,
    editingSculpture,
    setEditingSculpture,
    savingCanvasEdit,
    startCanvasModification,
    handleSaveCanvasModification,
    hasOwnedLand,
    ownedLandCount
  };
}

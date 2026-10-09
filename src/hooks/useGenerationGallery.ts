'use client'
import { useState, useCallback, type Dispatch, type SetStateAction } from 'react'
import type { GalleryItem } from '@/types/gallery'

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useGenerationGallery(_storageKey: string, _galleryType?: string) {
  const [items, setState] = useState<GalleryItem[]>([])

  const addItem = useCallback((item: GalleryItem) => {
    setState(prev => [item, ...prev])
  }, [])

  const updateItem = useCallback((id: string, updates: Partial<GalleryItem>) => {
    setState(prev => prev.map(i => i.id === id ? { ...i, ...updates } : i))
  }, [])

  const removeItem = useCallback((id: string) => {
    setState(prev => prev.filter(i => i.id !== id))
  }, [])

  const setAllItems = useCallback((newItems: GalleryItem[]) => {
    setState(newItems)
  }, [])

  // Backward-compat aliases for existing callers
  const deleteItem = removeItem
  // setItems exposes full React dispatch (accepts value or functional updater)
  const setItems: Dispatch<SetStateAction<GalleryItem[]>> = setState

  return { items, addItem, updateItem, removeItem, deleteItem, setAllItems, setItems }
}

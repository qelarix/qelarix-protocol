export interface GalleryItem {
  id: string
  type: 'image' | 'video' | 'audio'
  url: string
  prompt: string
  model: string
  credits: number
  aspectRatio?: string
  duration?: number
  isPublic?: boolean
  createdAt: number
  status?: 'generating' | 'completed' | 'failed'
  progress?: number
}

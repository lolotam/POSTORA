// Canvas Node Type Definitions - 4-Node System

export type NodeCategory = 'caption' | 'media' | 'platform' | 'image_gen';

export interface NodePort {
  id: string;
  label: string;
  type: 'string' | 'media' | 'platform_config' | 'any';
  required?: boolean;
}

export interface NodeTypeDefinition {
  type: string;
  label: string;
  description: string;
  category: NodeCategory;
  icon: string;
  inputs: NodePort[];
  outputs: NodePort[];
}

// Category metadata for UI
export const NODE_CATEGORIES: Record<NodeCategory, { 
  label: string; 
  color: string; 
  bgColor: string;
  borderColor: string;
  hex: string;
  description: string;
}> = {
  caption: { 
    label: 'Caption', 
    color: 'text-blue-500', 
    bgColor: 'bg-blue-500/10', 
    borderColor: 'border-blue-500/30',
    hex: '#3B82F6',
    description: 'Write your post caption'
  },
  media: { 
    label: 'Media', 
    color: 'text-foreground', 
    bgColor: 'bg-muted', 
    borderColor: 'border-border',
    hex: '#A855F7',
    description: 'Add images or videos'
  },
  image_gen: { 
    label: 'Image Gen', 
    color: 'text-amber-500', 
    bgColor: 'bg-amber-500/10', 
    borderColor: 'border-amber-500/30',
    hex: '#F59E0B',
    description: 'Generate images with AI'
  },
  platform: { 
    label: 'Platform', 
    color: 'text-green-500', 
    bgColor: 'bg-green-500/10', 
    borderColor: 'border-green-500/30',
    hex: '#10B981',
    description: 'Configure & publish'
  },
};

// Node Types
export const NODE_TYPES: NodeTypeDefinition[] = [
  // Text Caption Node - For writing captions
  {
    type: 'text_caption',
    label: 'Caption',
    description: 'Write your post caption with AI assist & hashtags',
    category: 'caption',
    icon: 'Type',
    inputs: [],
    outputs: [{ id: 'caption', label: 'Caption', type: 'string' }],
  },

  // Media Node - Upload, Stock, or Generate
  {
    type: 'media',
    label: 'Media',
    description: 'Upload files, browse stock, or generate with AI',
    category: 'media',
    icon: 'Image',
    inputs: [],
    outputs: [{ id: 'media', label: 'Media', type: 'media' }],
  },

  // Image Generator Node (was "caption")
  {
    type: 'caption',
    label: 'Image Generator',
    description: 'Generate images from text prompts with AI',
    category: 'image_gen',
    icon: 'Wand2',
    inputs: [],
    outputs: [{ id: 'image-out', label: 'Image', type: 'media' }],
  },

  // Platform Node - All platform-specific settings
  {
    type: 'platform',
    label: 'Platform',
    description: 'Select platforms and configure posting settings',
    category: 'platform',
    icon: 'Share2',
    inputs: [
      { id: 'caption', label: 'Caption', type: 'string', required: true },
      { id: 'media', label: 'Media', type: 'media' }
    ],
    outputs: [{ id: 'result', label: 'Result', type: 'any' }],
  },
];

// Get nodes by category
export const getNodesByCategory = (category: NodeCategory): NodeTypeDefinition[] => {
  return NODE_TYPES.filter(node => node.category === category);
};

// Get node type definition
export const getNodeTypeDefinition = (type: string): NodeTypeDefinition | undefined => {
  return NODE_TYPES.find(node => node.type === type);
};

// Connection validation rules
export const VALID_CONNECTIONS: Record<string, string[]> = {
  // source_handle_id -> allowed target_handle_ids
  'caption': ['caption'],      // text caption output -> platform caption input
  'media': ['media'],          // media output -> platform media input  
  'image-out': ['media'],      // image gen output -> platform media input
  'result': [],                // platform result output -> nothing (terminal)
};

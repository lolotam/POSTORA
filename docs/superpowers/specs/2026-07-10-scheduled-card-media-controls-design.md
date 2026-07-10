# Scheduled Card Media Controls Design

## Scope

Improve cards on `/scheduled` without changing the scheduling query, publishing flow, or database schema.

The card will:

- let the user move all attached media into an existing media-library folder;
- show every distinct post type represented by the post metadata: Feed, Story, and Reel;
- render two to ten carousel items in a horizontally scrollable thumbnail strip.

## Existing Model

Posts reference media through `posts.media_file_ids`. Media folders are represented by `media_files.folder_path` and `media_folders.full_path`; posts do not own a separate folder value. Post types are stored in JSON metadata, primarily in `facebook_post_type` and `instagram_post_type`, and may be strings or arrays.

The current folder icon labels social profiles rather than media-library folders. That social-profile display remains unchanged. A separate media-folder control will be added beside the media preview so its meaning is explicit.

## Folder Control

`ScheduledPosts` will load the current user's `media_folders` once. `ScheduledPostMedia` will include `folder_path` when it resolves the post's media rows and derive one of three labels:

- the matching folder name when every item shares one path;
- `Multiple folders` when attached items have different paths;
- `Media Library` for the root path `/`.

Selecting a destination performs one ownership-scoped update against `media_files`, setting `folder_path` for every ID in the scheduled post. The control is disabled while saving. On success, the local media state updates and a success toast appears. On failure, the prior label remains and a destructive toast reports the error.

Empty posts and media rows that cannot be resolved do not render the folder control. Folder options include the root Media Library and all available folders, ordered by path so nested folders remain understandable.

## Post Type Badges

The existing API/Manual source badge remains. A small helper will normalize post types from metadata and return distinct values in the stable order Feed, Story, Reel.

The helper will accept string or array values from:

- `metadata.facebook_post_type`;
- `metadata.instagram_post_type`;
- the legacy `metadata.instagram.mediaType` fallback.

It will normalize `stories` to `story`, ignore unsupported values, and default to Feed only for Facebook or Instagram posts whose metadata contains no recognized post type. The card renders one compact badge for every distinct normalized type.

## Carousel Preview

Single media keeps the current larger square preview. Posts with two to ten resolved media items use smaller square tiles in one horizontal row with `overflow-x-auto`, scroll snapping, and touch-friendly scrolling. All items remain available rather than collapsing into a `+N` tile.

Each tile retains the current image/video treatment, tooltip, keyboard focus, and lightbox behavior. Loading placeholders match the number of requested items up to the supported maximum of ten.

The card width remains unchanged on desktop and mobile. Horizontal scrolling prevents ten thumbnails from increasing the card width or forcing excessively small images.

## Data Flow

1. `ScheduledPosts` loads scheduled posts, accounts, profiles, and media folders.
2. Each `ScheduledPostMedia` resolves its ordered media IDs, URLs, media kind, and folder path.
3. The component renders the media strip and current folder label.
4. A folder selection updates all referenced `media_files` rows and then updates local folder state.
5. Post-type badges are derived directly from each post's existing metadata.

## Testing

Focused tests will cover:

- normalizing string, array, legacy, duplicate, and missing post-type metadata;
- deriving root, shared, and mixed folder labels;
- rendering every carousel item rather than an overflow tile;
- updating every media ID when a folder is selected;
- preserving the previous folder state when the update fails.

Run the existing type check, relevant unit tests, and build. Existing unrelated worktree changes must remain untouched.

## Out Of Scope

- adding or renaming folders from a scheduled card;
- changing social-profile assignments through the folder control;
- assigning different destination folders to individual carousel items;
- changing `/calendar` cards;
- changing the post composer, n8n node, MCP schema, or publishing functions;
- adding a post-level folder column or a post-media join table.

# Codebase Summary

## Key Components and Their Interactions
### Editor Core (src/vs/editor)
- Text editing engine
- Selection and cursor management
- Syntax highlighting basics
- Search and replace functionality

### Workbench (src/vs/workbench)
- Main application shell
- Layout management
- UI components
- Command palette

### Platform Services (src/vs/platform)
- File system operations
- Configuration management
- Keybinding system
- Basic services infrastructure

## Data Flow
- Main Process (Electron)
  - Window management
  - Native OS integration
  - File system access
- Renderer Process
  - Editor UI rendering
  - Text processing
  - User interaction handling
- IPC Communication
  - File operations
  - Configuration updates
  - Window state management

## External Dependencies
See techStack.md for detailed dependency information

## Recent Significant Changes
- Initial documentation setup completed
- Configured minimal UI settings:
  - Hidden activity bar
  - Single tab mode
  - Hidden menu bar
  - Disabled command center
  - Disabled layout controls
- Removed unnecessary workbench contrib directories:
  - debug (debug capabilities)
  - terminal (built-in terminal)
  - extensions (extension system)
  - remote (remote development)
  - scm (git/source control)
  - tasks (task running)
  - testing (testing framework)
  - notebook (notebook support)
  - webview (webview support)
  - chat (chat features)
  - inlineChat (inline chat)
  - comments (commenting system)
  - performance (performance features)
  - customEditor (custom editor support)

## UI Architecture
The workbench UI is composed of several parts:
- Editor: Core text editing area
- Status Bar: Optional bottom bar
- Title Bar: Optional top bar
- Activity Bar: Hidden by default
- Side Bar: Available but hidden by default
- Panel: Available but hidden by default

All UI parts can be toggled through the layout service, with default visibility controlled through product.json configuration.

## User Feedback Integration
To be updated during development and testing phases

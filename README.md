# CollabDraw

An open-source collaborative drawing application inspired by Excalidraw, built with Next.js and Canvas API. Create beautiful hand-drawn diagrams and collaborate in real-time with others.

## Features

- 🎨 Draw shapes with a hand-drawn, sketchy feel using Rough.js
- ✏️ Multiple drawing tools:
  - Freehand drawing
  - Lines and Arrows
  - Rectangles and Circles (hold Shift for perfect squares/circles)
  - Text annotations
  - Eraser tool
- 🎯 Smart shape manipulation:
  - Drag and drop with snapping to other shapes
  - Resize with handles
  - Hold Shift for constrained angles (15° increments)
  - Grid snapping for precise placement
- 🤝 Real-time collaboration features:
  - See other users' cursors
  - Synchronized drawing state
  - Live shape updates
- ⚡ Performance optimized:
  - Canvas-based rendering
  - Efficient state management
  - Smooth drawing experience
- 🔄 Undo/Redo functionality
- 💾 History management

## Getting Started

### Prerequisites

- Node.js 18.0 or later
- npm or yarn

### Installation

1. Clone the repository:

```bash
git clone https://github.com/yourusername/collabdraw2.git
cd collabdraw2
```

2. Install dependencies:

```bash
npm install
# or
yarn install
```

3. Run the development server:

```bash
npm run dev
# or
yarn dev
```

4. Open [http://localhost:3000](http://localhost:3000) in your browser.

## Project Structure

```
collabdraw2/
├── app/                    # Next.js app directory
│   ├── components/        # React components
│   │   ├── AppCursors.tsx   # Collaborative cursors
│   │   ├── Canvas.tsx       # Main canvas component
│   │   └── canvas/         # Canvas-related components
│   ├── context/          # React context providers
│   ├── hooks/            # Custom React hooks
│   └── services/         # Business logic and services
├── public/               # Static assets
└── types/               # TypeScript type definitions
```

## Contributing

We welcome contributions! Here's how you can help:

1. Fork the repository
2. Create a feature branch:

```bash
git checkout -b feature/amazing-feature
```

3. Make your changes
4. Run tests (if available) and ensure code quality:

```bash
npm run lint
npm run test
```

5. Commit your changes:

```bash
git commit -m 'Add amazing feature'
```

6. Push to your branch:

```bash
git push origin feature/amazing-feature
```

7. Open a Pull Request

### Development Guidelines

- Follow the existing code style
- Write meaningful commit messages
- Add comments for complex logic
- Update documentation when needed
- Test your changes thoroughly

### Code Style

- Use TypeScript for type safety
- Follow the [React Hooks guidelines](https://reactjs.org/docs/hooks-rules.html)
- Maintain component modularity
- Use meaningful variable and function names

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- Inspired by [Excalidraw](https://excalidraw.com/)
- Built with [Rough.js](https://roughjs.com/) for sketchy rendering
- Uses [Next.js](https://nextjs.org/) for the framework
- Real-time features powered by Socket.io

## Support

For support, please open an issue in the GitHub repository.

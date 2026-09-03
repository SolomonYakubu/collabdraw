# Contributing to CollabDraw

Thank you for considering contributing to CollabDraw! We welcome contributions from the community to make this project better.

## How to Contribute

1. **Fork the Repository**: Start by forking the repository to your GitHub account.
2. **Clone the Repository**: Clone the forked repository to your local machine.
   ```bash
   git clone https://github.com/your-username/collabdraw.git
   ```
3. **Create a Branch**: Create a new branch for your feature or bug fix.
   ```bash
   git checkout -b feature/your-feature-name
   ```
4. **Make Changes**: Implement your changes and commit them with clear commit messages.
   ```bash
   git commit -m "Add feature: your feature description"
   ```
5. **Push Changes**: Push your changes to your forked repository.
   ```bash
   git push origin feature/your-feature-name
   ```
6. **Submit a Pull Request**: Open a pull request to the main repository and describe your changes.

## Code of Conduct

Please follow our [Code of Conduct](CODE_OF_CONDUCT.md) to ensure a welcoming environment for everyone.

## Reporting Issues

If you encounter any issues, please open an issue in the repository with a detailed description.

## Development Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Run the development server:
   ```bash
   npm run dev
   ```
3. Before opening a pull request, run the test suite:
   ```bash
   npm test
   ```
   See [README.md](README.md#tests) for what it does and does not cover yet.
4. Lint your changes. The lint script treats warnings as failures, so it must be
   clean before you open a pull request:
   ```bash
   npm run lint
   ```
   `npm run lint:fix` applies the fixes ESLint can make on its own.

Thank you for contributing!

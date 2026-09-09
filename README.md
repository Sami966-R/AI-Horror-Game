# AI Horror Maze 🕹️

![Gameplay Preview]
<img width="942" height="882" alt="image" src="https://github.com/user-attachments/assets/eb2bf33f-c32c-48be-bed8-c884297fd261" />

**[Play the Live Demo Here](https://sami966-r.github.io/AI-Horror-Game/)**

## Overview
This is a grid-based 2D survival horror game built entirely from scratch using Vanilla JavaScript and HTML5 Canvas. The objective is to navigate a procedurally generated maze, locate the exit, and survive being hunted by an enemy AI. 

The primary focus of this project is the implementation of formal algorithmic logic and graph theory to create intelligent enemy behavior and dynamic environments without relying on external game engines.

## Core Features & Algorithms
* **Algorithmic Pathfinding:** The enemy AI utilizes the **A* (A-Star) Search Algorithm** to dynamically calculate the shortest path to the player in real-time, evaluating both distance and traversal cost. 
* **Procedural Maze Generation:** The grid environment is generated dynamically on load utilizing **Recursive Backtracking (DFS)** to ensure no two playthroughs are exactly the same while guaranteeing a mathematically solvable path to the exit.
* **Line-of-Sight Rendering:** Implemented a radial rendering mask ("Fog of War") on the HTML5 Canvas to simulate a flashlight effect, enhancing the horror atmosphere and restricting player information.
* **Zero Dependencies:** Built strictly with native web technologies to demonstrate core software engineering principles, memory management, and object-oriented programming.

## Tech Stack
* **Frontend:** HTML5 Canvas, CSS3
* **Logic:** Vanilla JavaScript (ES6+)
* **Deployment:** GitHub Pages

## How to Run Locally
1. Clone the repository:
   ```bash
   git clone [https://github.com/Sami966-R/AI-Horror-Game.git](https://github.com/Sami966-R/AI-Horror-Game.git)

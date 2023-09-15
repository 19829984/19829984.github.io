---
layout: post
title:  "[Unreal 5] Making a Metal Slug Camera System"
date:   2023-09-12 08:50:00 -0500
categories: Tech_Art
---
<p align="center">
    <img src="/assets/metal_slug_cam/demo.gif">
    <h5 align="center"><i> Demo of the camera system in action. The white line represents active thresholds to scroll.</i></h5>
</p>

## Preface
Metal Slug is one of my favorite arcade game of all time (though I've only played it emulated). For an upcoming project that I'm working on, I wanted to implement a similar system but in 2.5D. 

## Metal Slug’s Camera System
In Metal Slug (I'll abbreviate it as MS), most of the time the camera seems to be only moving towards the right as the player progress, but this is not the case. In certain areas, it allows the player to still move within a bound area that is larger than the camera’s play space. 

I first tried some BluePrint solutions that would move the camera along a fixed spline track, but after some thinking and replaying MS3 I realized that this doesn’t really work, at least not on its own. Across Metal Slug, I've noticed that the camera commonly are in one of three states:
1. **Forward Scrolling** - Player must move forward and the camera will only move forward. Vertical tracking of the player still occurs. This needs to support “forward” being either left or right to allow for more interesting level design. 
2. **Bounded** - The camera is bounded to a small area, or a area so small that no movement is possible. It will continuously track the player as they approach the screen’s threshold
3. **Auto Scrolling** - The camera continuously move forward in the environment at a fixed speed, while the player either must keep up by foot, stand on some kind of moving vehicle, or is piloting a moving vehicle that is already moving forward. Forward can either be to the right or up. Auto Scrolling up will basically be a shmup (shoot'em up) at that point. 

## Getting the camera to move

Something I’ve noticed that the threshold for scrolling varies between levels. For example, in MS3, the first level scrolls as soon as the player crosses a 30% screen space threshold, while the second level needs the player to be almost at the center of the screen before it can start scrolling. 

> Given that the second level is a zombie level where most enemies do not have long ranged attacks, this design decision was probably made to force the player to be closer to the enemies as they come from the right side of the screen.

### First Iteration
First I tried to check for the player’s screen space X coordinate and moving the camera such that they stay on the left side. This works, but the movement is jumpy and inconsistent using a constant scroll speed offset.

![Untitled](/assets/metal_slug_cam/jittery_implementation.png)

However, if we instead take the difference between the player’s screen space position % and the desired threshold and use that to scale the scroll speed, while clamping it, we then get the smooth camera movement that we want

![Untitled](/assets/metal_slug_cam/smooth_move1.png)

However, this still only supports moving in a single direction, we want the screen to be able to move left and right, as well as up and down for levels with slopes. 

For supporting both left and right scrolling, we make an Enum that has all 4 directions. For now we just use 2, Left and Right.

![Untitled](/assets/metal_slug_cam/old_enums.png)

### Second Iteration
Soon I realized that what I was writing wasn’t adaptable and scalable, so I worked my approach. 

We will define 4 different thresholds for each side of the screen, each toggle-able, we can then make each type of camera movement by configuring these variables. For example, forward scrolling can be achieve by simply toggling the left threshold off, while keeping the others on so the player can move to the right with vertical tracking. We will worry about bounding the camera to a specific area later. 

I made a struct that allows toggling of scrolling on each side of the screen as well as adjusting their individual thresholds. This way, I can dynamically toggle then quickly in the editor, as well as dynamically in other blueprints later on. 

![Untitled](/assets/metal_slug_cam/new_struct.png)

The Blueprint looks like this 

![Untitled](/assets/metal_slug_cam/new_move.png)

I’ve added some simple debug HUD elements to visualize the thresholds

**TODO** fix this
[16cb5bb902d9b74f8cd72ef17042a95f.mp4](Metal%20Slug%20Styled%20Camera%20movement%204ae22505b6d9498ab1e02c757f764ec1/16cb5bb902d9b74f8cd72ef17042a95f.mp4)

I then integrated it with moving the camera along a fixed path, as well as bounding the player within screen space. 

Bounding the player within screenspace needed a bit of extra work. In traditional 2D we can simply calculate the world position of the bounds, and clamp the player’s position within them. In 2.5D we theoretically could do the same but this needs the third axis to be a constant number

It was also around this time I realized that perhaps instead of using a single camera pawn and trying to build an entire level around it, we can just use multiple pawns with disconnected tracks, or having some not on tracks at all, and just use the level to move it. We then use `Set View Target To` to smoothly blender between each pawn. With this, we can also easily implement stopping the camera at certain points: we just end the track and set a new view target once the player hits a trigger volume. 

********************Later Note:********************
TODO: Move this
Using get viewport size does not actually get the rendered viewport size, but instead the window size. So with constrained aspect ratio enabled on the camera, we’re using the wrong values to calculate our scroll. To fix this we must first determine which axis is our dominant axis, then use our known aspect ratio to calculate the true viewport size. 

We’re also going to reimplement these scripts as C++ code in a parent class. See [Convert camera code to C++ Code](https://www.notion.so/Convert-camera-code-to-C-Code-5e886e98dcaa4e73a2838f89aabf4685?pvs=21) 

## Bounded Camera

For this I’ve decided to take a simple approach, we simply clamp the relative position of the spring arm, since we’re now using that to do secondary tracking on the player. Though, this isn’t easy to visualize, and we will need to develop visualizers to help determine what the camera can and cannot see for better level design. 

## Auto Scroll

With what we’ve built above, autoscroll is easy. Just disable scrolling, and increment the internal variable for the camera’s path input key, or simply move the camera component itself. 

# Building the Tools

Never built editor tools for games before, so here’s a first for everything. 

This is the basic tool I built to help with previewing how the level will look during gameplay

![Untitled](Metal%20Slug%20Styled%20Camera%20movement%204ae22505b6d9498ab1e02c757f764ec1/Untitled%205.png)

The slider allows the level designer to scroll along the camera’s path, and quickly switch between the current and next camera.

This system works on assigning the tag `Camera_n` to the nth Camera in the intended sequence of cameras. Then using that to find the next camera or previous camera to switch to. But this introduces a lot of repetitive assigning of tags whenever we want to add a new camera to the sceme

### How do we manage all these tags efficiently?

To make managing the tag less tedious, I’ve modified `BP_CameraPawn`’s Construction Script check if itself has a `Camera_n` tag already, or if another camera in the scene has the same tag. If so, find the tag with the highest `n` value, then assign to itself `Camera_<n+1>`

# Using the Camera Manager

At this point I’ve decided to make use of Unreal’s Camera Manager system. To make this work, we need to modify `BP_CameraPawn` to, upon BeginPlay, find and store the next and previous camera via the aforementioned tags as variables (akin to linked lists). This way, when we want to transition to the next camera, we just need to access these variables from the Camera Manager, and set the desired camera as the new view target. To trigger a transition, we just need to call a custom event within our Camera Manager. 

# Bringing it together

Now all that’s left is to use the systems I’ve built and attempt to build a basic level. The level should include

- Basic forward scrolling
- Bounded camera with no tracking
- Bounded camera with tracking

Then, we should try to build some tools to help level designers visualize how the level is going to play while adjust the camera path and parameters 

# Bugs

If we do not expose `Last_Spline_Inputkey` to the editor, then it will repeatedly get reset to the default value whenever we change anything about a camera.

---
layout: post
title:  "[Unity/VRChat] Creating a synced whiteboard in VRChat"
date:   2023-09-02 08:50:00 -0500
categories: Tech_Art
---

<p align="center">
    <img src="/assets/vr_whiteboard/demo.gif">
    <h5 align="center"><i> Demo of the whiteboard working between two networked players</i></h5>
</p>

## Table of Contents
- [Table of Contents](#table-of-contents)
- [Preface](#preface)
  - [How VRChat Players Usually Draw](#how-vrchat-players-usually-draw)
- [Requirements](#requirements)
- [SDF (Signed Distance Field)](#sdf-signed-distance-field)
  - [Limitations of SDFs](#limitations-of-sdfs)
- [Psuedo Whiteboard Rendering Pipeline](#psuedo-whiteboard-rendering-pipeline)
- [Network Sync and Serialization](#network-sync-and-serialization)
  - [Polyline](#polyline)


## Preface
I was replicating a room from my college for use in VRChat, and it has some whiteboards. Naturally, we'd want to be able to draw on them in VRChat. However, this room has 8 sliding whiteboards and 4 static whiteboards, making a total of 12 whiteboards. This presented some technical challenges that took me a while to figure out, so I'd like to document my implementation here.

### How VRChat Players Usually Draw
VRChat provides sample prefabs that includes a pen for players to draw in 3D space. This is achieved by drawing ribbons along the points the pen samples in 3D space. However, this is not a good fit for whiteboards primarily because the number of ribbons must be limited, since they are their own GameObjects and can easily clutter the scene and reduce fps. We don't want people's pen strokes to start disappearing from the whiteboards as they put down more marks. Further, to replicate the feel of drawing on a whiteboard, we want strokes to be erasable and merge together when overlapped. Therefore, we must go with a texture solution. 

<p align="center">
    <img src="/assets/vr_whiteboard/3d_pen_example.png">
    <h5 align="center"><i> Ribbons being drawn in 3D space</i></h5>
</p>

## Requirements
These whiteboards must:
-   Have high image fidelity(smooth strokes)
-   Support colors
-   Erasable
-   Share one texture to save resources
-   Sync across the network

## SDF (Signed Distance Field)
*For more info about SDFs, read about them [here](https://iquilezles.org/articles/raymarchingdf/):*

The first and fourth requirement seems to contradict each other. Since the whiteboards will be viewed from up close and far away, to preserve stroke quality we'd need to allocate a large amount of pixels per whiteboard. However, to share that texture across 12 different whiteboards means that it must be an extremely large texture, which is simply unfeasible; especially for a VR application. 

Taking inspiration from Valve's [excellent paper](https://iquilezles.org/articles/raymarchingdf/) on rendering high quality glyphs with SDFs, the solution here is to use ***Signed Distance Fields(SDFs)*** as our texture. As seen from Valve's **Figure 1** example, they can render high quality images with small textures using only 8bit color depth. With this technique, we can combine the SDF textures for every whiteboard onto a single smaller texture that won't eat up all of our precious VRAM. 

### Limitations of SDFs
If we use SDFs, this means that we are limited on how many colors we can display. SDFs work of off single channel data, meaning that the source texture no longer represents color in RGBA, but instead represents 4 different SDFs, barring us from representing all colors. I think this tradeoff is well worth it, given the amount of resources we save with the SDF technique, as well as the high definition images we get out of it. 

## Network Sync and Serialization
To make the whiteboard work properly in multiplayer is rather tricky. We cannot directly serialize and deserialize textures over network in VRChat, since our bandwidth is **extremely limited**.

From [VRChat documentation](https://creators.vrchat.com/worlds/udon/networking/network-details/):

>Continuous sync is limited to roughly **200 bytes** per serialization.
>
>Manual sync is limited to roughly **49 Kilobytes** per serialization.
>
>Each manually-synced object is rate limited as a factor of the data size. The more it sends, the more its send rate is limited. You can call RequestSerialization as many times as you want, but it will wait until enough time has passed before calling OnPreSerialization, sending the data, and calling OnPostSerialization with the result.
>
>A single synced string can have roughly 126 characters in Continuous sync mode.
>
>You can send out about **11kb per second**.

At first, the pen would directly draw onto the client's render textures every frame while it's in contact. I tried to simply sync the transforms of a marker as often as I can, hoping that each client's result would be close enough, but that wasn't the case at all. 
<p align="center">
    <img src="/assets/vr_whiteboard/shit-network-1.png" width="50%"><img src="/assets/vr_whiteboard/shit-network-2.png" width="50%">
    <h5 align="center"><i>Two clients in the same world having wildly different results</i></h5>
</p>

### Polyline
So instead, at the suggestion of my friend [HeadMerchant](https://github.com/HeadMerchant), I changed the implementation to record polylines by sampling the pen's position, then drawing each polyline onto the whiteboard when it reaches a certain length or stops. 

Before a new polyline is drawn, we record the current one and serialize its data over the network. We use `Vector4[]` to store our polyline (`xyz` for position, `w` for color), so the amount of data we send over the network is negligible with short polylines. A `Vector4` has 4 `floats`, each `float` is 4 `bytes`, therefore with each polyline we send `polylineLength * 16` bytes of data. 

Since we're manually syncing, we are well below our 49 `kilobyte` per serialization bandwidth as long as we don't make each polyline too long. Theoretically, we can have `49*1024/16=3136` points per polyline before we each the manual sync limit. 

## Whiteboard Rendering Pipeline
With the rendering technique and our data structure established, now we can define a rather simple rendering pipeline:
1. Draw a polyline stroke onto a render texture as a SDF
2. Blit the render texture to one of the 4 channels in the whiteboard render texture, or subtract from all channels if erasing.
3. Render the SDF texture with a custom shader on a whiteboard object

While my friend HeadMerchant suggested using Custom Render Textures' double buffering feature to combine both the stroke render texture and the whiteboard render texture, unfortunately due to limitations in UdonSharp, Custom Render Textures are unavailable to us; nor were command buffers. Therefore, we must manually create both render textures and call `VRCGraphics.Blit()` manually to render our textures. 



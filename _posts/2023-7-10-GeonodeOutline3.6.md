---
layout: post
title:  "[3.6 UPDATE] Geometry Node Screen-space Invert Hull Outlines"
date:   2023-07-10 00:30:00 -0500
categories: Tech_Art
---

#### Table of Contents
- [Blender 3.6 Update](#blender_3.6)
- [Preface](#preface)
- [Simple Invert Hull in Blender](#simple_invert_hull_blender)
- [Geometry Node Based Invert Hull](#geonode_invert_hull)
- [Implementation Time!](#implementation_time)
  - [Project Normals to Camera Plane](#step_1)
  - [Scale Projected Normal Vectors in Screen Space](#step_2)
  - [Re-Project Back to Original Normal Vectors](#step_3)
  - [Final Steps](#step_4)


## Blender 3.6 Update {#blender_3.6}
In the [old version](/tech_art/2023/03/02/GeonodeOutline.html) of this post, you'd need to re-setup the drivers whenever you want to use it in a new file simply due to Blender's limitations with it comes to linked libraries and drivers. 

However, with Blender's 3.6 update, Drivers now can use conteext properties, which allows a driver to implicitly  reference the active scene or view layer. This allows us to set up these drivers once in the character file that's using our outline nodes, and reuse them via library links without additional setup.

This update makes the geometry nodes easier to setup. Since I've also made a couple of minor changes since I wrote the old version, I'll also include them here. **For changed content**, skip to [implementation time](#implementation_time)

## **Preface** {#preface}
In stylized realtime rendering, one way to achieve outlines is the ***Invert Hull*** method; the mesh is duplicated, each vertex offset along the normal, and is rendered via a back-face-only material with a solid color. You can see this employed by Arc System Works in their 3D anime fighting games such as the recent installments of the Guilty Gear series.

![GG Xrd Example](/assets/geonode_outline/images/guilty_gear_example.jpg)
<center><h5><i> Look closely on the outlines, and you can see how it follows the polygons. This is especially evident on Sol's left deltoids. </i></h5></center>

## **Simple Invert Hull in Blender** {#simple_invert_hull_blender}
In Blender, the easiest way to achieve this is to use the *Solidify* modifier with flipped normals and a material that only renders the back-face. 
<center>
<img src="/assets/geonode_outline/images/simple_invert_hull_example.png" width="400"> <img src="/assets/geonode_outline/images/simple_invert_hull_modifier_example.png" width="250">
</center>
<center><h5><i> The mesh has an outer shell, which is the invert hull outline. Notice that we have <b>Material Offset</b> set to 1, meaning the solidified mesh will use the second material slot assigned to the mesh, which is a black emissive material that only renders its back-face. </i></h5></center>
  
However, this has **limitations**:
- The modifier can only act on one mesh at a time, making managing this on a multi-mesh character, or an entire scene, difficult without building additional tooling. 
- The modifier has a uniform value for how far to extrude the outline mesh. Meaning the outline thickness is defined in world space.
  - This can be attenuated with vertex weights, but modifying vertex weights in real time is bit of a pain in Blender, and we can only use values between 0-1
- At extreme angles, world space outline thickness makes the closer part of the mesh appear to have a thicker outline than the rest of the mesh.
  - Though depending on art direction, this could be desirable.

![Extreme Angle Example](/assets/geonode_outline/images/simple_extreme_example.png)
<center><h5><i> The hand's outline is significantly thicker than the objects behind it, and the outlines on the button are clipping as well </i></h5></center>

### So how do we do this?
In order to achieve a more consistent and uniform invert hull result, we must redefine its thickness in screen space. Normally in a game engine, this is easy to do: you'd implement invert hull in geometry shaders, with the vertex shader passing in the screen-space/clip space matrix for you to then perform invert hull calculations. 

Unfortunately in Blender, we **do not have access** to the vertex or geometry shader, nor do we have access to any matrices outside of Python scripts. So here's where **Geometry Nodes** come in.

## **Geometry Node Based Invert Hull** {#geonode_invert_hull}
With **Geometry Nodes**, rather than only being able to extrude the invert hull cage along its vertex normal, we can specify exactly how we want it to move. With some simple vector math, we can achieve a result that gets you a much more uniform invert hull thickness within screen space. This means that the **outlines stays consistent regardless of your camera's rotation and location**; allowing you to set and forget then carry on with the rest of your animation. Plus, we can organize the nodes such that every outline can be controlled from one (or arbitrary many) places.

![Fixed Extreme Angle Example](/assets/geonode_outline/images/advanced_extreme_example_.png)
<center><h5><i> Now the entire model's outline is much more uniform, with the buttons looking much better too </i></h5></center>
<center>
<img src="/assets/geonode_outline/gifs/outline_demo_gif.gif" width="800">
<h5><i> Realtime Demo </i></h5>
</center>
![Geonode Overview](/assets/geonode_outline/gifs/geonode_demo_gif.gif)
<center><h5><i> The outline of every mesh can be controled by changing the property of a single Geometry Node graph </i></h5></center>

### The basic principle
So the idea is to take our vertex normal vector, project it such that it is parallel to the near-plane/far-palne of the camera, then scale it by a factor that is will be the length that we want it to be in screen space, and finally projecting it back to the original normal vector while preserving its screen space length. We then create the inverse hull mesh using these new vectors, rather than just the normal vectors in the traditional method.

So that was a mouthful of words, which probably wasn't too helpful to many people. So here's a more visual demonstration, where the arrows represent the normals.
![Process Demo](/assets/geonode_outline/gifs/process_demo.gif)
1. The first transform is projecting the normals to be parallel to the camera's near/far plane.
2. Then we scale the vectors such that they're the same size in screen space. 
3. We re-project the vectors back onto the original normal vectors while maintaining their screen space size. This is to avoid artifacts from the shell clipping with the original model. 
    
From the camera's point of view, the last step doesn't look like the vectors have changed direction or length at all, which is what we want. 
![Process Demo from Cam](/assets/geonode_outline/gifs/process_demo_from_cam.gif)
<center><h5><i> The vector arrows still changes slightly due to them moving towards/away from the perspective camera in 3D space still </i></h5></center>

## **Implementation Time!** {#implementation_time}

### 1. Project Normals to Camera Plane {#step_1}
First we need to retrieve data about the active camera with the following node setup to obtain the active camera's world space location, XYZ euler rotation, as well as vectors.
![Active Camera Data Node Setup](/assets/geonode_outline/images/1_active_camera_data_node.png)
<center><h5><i> We make use of context properties obtain the active camera's world space location and rotation. </i></h5></center>

With that node group ready to go, we can now take the normal vectors of our mesh and project them to be parallel to the near/far plane of the camera.
![Normal Projection Geo Nodes](/assets/geonode_outline/images/1_normal_proj_overview_3.6.png)
<center><h5><i> Calculate Camera view vector from (0,0,-1); the default camera orientation, then project normals to camera plane. </i></h5></center>

### 2. Scale Projected Normal Vectors in Screen Space {#step_2}
**2a.** First we calculate the **world space length** of X pixels in screen space at each vertex. Specifying pixel count works, but when render resolution changes so does the outline size, so I added a screen-space ratio option to preserve outline sizes regardless of the resolution. 

![Calculate World Space Distance Per Pixel](/assets/geonode_outline/images/2a_pixel_dist_geo_node_3.6.png)

**2b.** To make the Outlines dynamically respond to changing camera parameters, we pass in the *focal length* and *dimensions* through **drivers** using context properties.

<center>
<img src="/assets/geonode_outline/images/focal_length_driver_3.6.png" height="300"> <img src="/assets/geonode_outline/images/resolution_driver_3.6.png" height="300"><img src="/assets/geonode_outline/images/driver_connection.png" height="300"></center>

**2c.** Attenuate and multiply with step 1. Attenuation with `Outline Scaling Power` allows us to make the outline scaling behave nonlinearly.

![Attenuation and G Vector](/assets/geonode_outline/images/2c_attenuation.png)

### 3. Re-Project Back to Original Normal Vectors {#step_3}
Because we've projected our normal vectors to be parallel to the near/far plane, when they are used to create the inverse hull, the hull may often clip the original mesh, causing artifacts. Therefore, we must reproject our vectors back to the normal vector, while preserving their screenspace size.
![Re-projection](/assets/geonode_outline/images/3_reprojection_3.6.png)
<center><h5><i> Check out <a href="https://vixra.org/pdf/1712.0524v1.pdf">this PDF</a> for an explanation on projecting a vector onto a plane from any angle </i></h5></center>
![Re-projection_2](/assets/geonode_outline/images/3_vector_projection_group.png)
<center><h5><i> Inside of the VectorProjection vector group </i></h5></center>

### 4. Final Steps {#step_4}
**4a.** We may see weird artifacts when the reprojected vector is close to being parallel to the vector from the camera to the vertex, because the reprojected vector needs to be scaled to a large degree after step 2 to be parallel to the original normal vector. So we must attenuate these vectors. Luckly for us, where these vectors occur also happens to be there the inverse hull is not visible, so we can simply scale them down. 

We can do so by:
1. Use the dot product of the g Vector and original Normal vectors to determine which vectors we need to cull. The more parallel they are, 
2. We do not care about direction, only parallel-ness, so we use the absolute value. This also makes the range of the values to be [0-1]
3. We then invert the values, this makes it such that the closer a vector is to being parallel with the r vector, the closer it is to 0.
4. Then use power and mix to attenuate, and finally scale our reprojected vector with it. 

![Culling](/assets/geonode_outline/images/4_culling_3.6.png)
<center><h5><i> Dot Product's input B is the g Vector, and B is the s Vector from 3 </i></h5></center>

**4b.** We want to provide options for using and world space constant outlines and blending between that and screen space outlines, so we add the following nodes.
![World Space Outline Option](/assets/geonode_outline/images/4_world_space_outline_3.6.png)
**4c.** We make use of vertex weights to allow further user attenuation of the outlines. Also, the re-projection may cause some vectors to point inside of the mesh instead of out, do we perform a dot product check and invert the vectors. This still preserves the screen space size of our outlines.
![Weight and inversion Check](/assets/geonode_outline/images/4_weight_inversion_check_3.6.png)
**4d.** Extruding our invert hull then just involves giving each vertex the offset that we calculated, flipping its normals, and setting an outline material.
![Done!](/assets/geonode_outline/images/4_finish.png)

**4e.** Now all you need to do is to grab the weight attribute and connect it to the input of our node group, and link up all other inputs to the inputs of the outermost group.
![Overview](/assets/geonode_outline/images/4_finish_overview.png)
<center><h5><i> 2 nodes in between to default the weights to 1 if the attribute does not exist </i></h5></center>

### Done!
And done! Now you have a geometry node group that takes a geometry and material, and outputs invert hull outlines in screen space, with a variety of adjustment options, and can be readily linked to other files and use. 

If you want to control the inverse hull of multiple mesh objects at once with this, nest it inside another layers of nodes, and use the top layer as the geometry node object for the modifiers of all desired objects.
